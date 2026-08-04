#!/usr/bin/env bash
#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
#     istio-up.sh <istio|skywalking|horizon|demo|rover>
#
# One stage of the istio fixture per invocation, so infra-e2e reports which
# stage failed instead of one opaque "setup failed".
#
# The `rover` stage no-ops when profiling is off (E2E_SKIP_PROFILING=true, or
# any non-Linux host — see profiling-enabled.sh, which the profiling
# verification consults too so the two halves can never disagree).

set -eu

STAGE="${1:?usage: istio-up.sh <istio|skywalking|horizon|demo|rover>}"

here=$(cd "$(dirname "$0")/../.." && pwd)   # test/e2e

# Naive on purpose: script/env is read the same way by every consumer, and
# `set -a; . env` would expand the argon2 hash's `$` sequences. See env.
#
# A value already exported in the caller's shell WINS over the file. The file
# holds the pins a run uses by default; exporting one in your shell is how you
# override it for your machine without editing a tracked file and having to
# remember not to commit it.
val() {
  eval "local override=\${$1:-}"
  if [ -n "${override}" ]; then
    echo "${override}"
    return
  fi
  grep -E "^$1=" "${here}/script/env" | head -1 | cut -d= -f2-
}

NS=istio-system

case "${STAGE}" in
  istio)
    # ALS is the whole point of the mesh fixture: Envoy reports every request
    # to OAP, and OAP builds the MESH topology and metrics from those access
    # logs. Without it the layer exists but stays empty.
    #
    # Tracing goes to OAP's Zipkin receiver because that is what the MESH
    # template reads; sampling is 100 so a short fixture window still has
    # traces in it.
    #
    # The metrics service carries the Envoy stats that mesh_dp's `card`
    # widgets read, and the inclusion regexps are what let those stats through
    # — Envoy publishes thousands and ships only a subset by default.
    istioctl install -y --set profile=demo \
      --set meshConfig.defaultConfig.envoyMetricsService.address=skywalking-oap.${NS}:11800 \
      --set meshConfig.defaultConfig.envoyAccessLogService.address=skywalking-oap.${NS}:11800 \
      --set meshConfig.enableEnvoyAccessLogService=true \
      --set meshConfig.defaultConfig.tracing.zipkin.address=skywalking-oap.${NS}:9411 \
      --set meshConfig.defaultConfig.tracing.sampling=100 \
      --set 'meshConfig.defaultConfig.proxyStatsMatcher.inclusionRegexps[0]=.*membership_healthy.*' \
      --set 'meshConfig.defaultConfig.proxyStatsMatcher.inclusionRegexps[1]=.*upstream_cx_active.*' \
      --set 'meshConfig.defaultConfig.proxyStatsMatcher.inclusionRegexps[2]=.*upstream_cx_total.*' \
      --set 'meshConfig.defaultConfig.proxyStatsMatcher.inclusionRegexps[3]=.*upstream_rq_active.*' \
      --set 'meshConfig.defaultConfig.proxyStatsMatcher.inclusionRegexps[4]=.*upstream_rq_total.*' \
      --set 'meshConfig.defaultConfig.proxyStatsMatcher.inclusionRegexps[5]=.*upstream_rq_pending_active.*' \
      --set 'meshConfig.defaultConfig.proxyStatsMatcher.inclusionRegexps[6]=.*lb_healthy_panic.*' \
      --set 'meshConfig.defaultConfig.proxyStatsMatcher.inclusionRegexps[7]=.*upstream_cx_none_healthy.*'
    kubectl label namespace default istio-injection=enabled --overwrite
    ;;

  skywalking)
    chart=$(val SW_HELM_CHART_COMMIT)
    oap_commit=$(val SW_OAP_COMMIT)
    banyandb_commit=$(val SW_BANYANDB_COMMIT)

    # BanyanDB, as principle 1 requires: this scenario is here for the mesh,
    # not for a second storage backend.
    #
    # SW_RECEIVER_ZIPKIN / SW_QUERY_ZIPKIN: the MESH layer template sources
    # its traces from Zipkin, not from SkyWalking's own trace query, so the
    # mesh Traces tab is dark without these. Istio is configured below to
    # report spans to the receiver, which makes this the one place the Zipkin
    # path is exercised with real mesh traffic.
    #
    # SW_QUERY_GRAPHQL_ENABLE_ON_DEMAND_POD_LOG: pod logs are read from the
    # Kubernetes API on demand rather than from storage, and OAP ships that
    # off by default. The chart's ClusterRole already grants pods/log.
    #
    # elasticsearch.enabled must be turned OFF explicitly. The chart ships it
    # on by default, so leaving it renders an `Elasticsearch` custom resource
    # whose CRD nothing installed, and helm fails the whole release with
    # "ensure CRDs are installed first" — which reads like a chart bug rather
    # than a storage choice that was never made.
    helm -n "${NS}" install skywalking \
      oci://ghcr.io/apache/skywalking-helm/skywalking-helm \
      --version "0.0.0-${chart}" \
      --create-namespace \
      --set fullnameOverride=skywalking \
      --set oap.replicas=1 \
      --set oap.image.repository=ghcr.io/apache/skywalking/oap \
      --set "oap.image.tag=${oap_commit}" \
      --set oap.storageType=banyandb \
      --set oap.envoy.als.enabled=true \
      --set oap.env.SW_ENVOY_METRIC_ALS_HTTP_ANALYSIS=k8s-mesh \
      --set oap.env.SW_ENVOY_METRIC_ALS_TCP_ANALYSIS=k8s-mesh \
      --set 'oap.env.K8S_SERVICE_NAME_RULE=${service.metadata.name}' \
      --set oap.env.SW_HEALTH_CHECKER=default \
      --set oap.env.SW_QUERY_GRAPHQL_ENABLE_ON_DEMAND_POD_LOG=true \
      --set oap.env.SW_RECEIVER_ZIPKIN=default \
      --set oap.env.SW_QUERY_ZIPKIN=default \
      --set oap.ports.zipkin-receiver=9411 \
      --set oap.ports.zipkin-query=9412 \
      --set elasticsearch.enabled=false \
      --set banyandb.enabled=true \
      --set banyandb.image.repository=ghcr.io/apache/skywalking-banyandb \
      --set "banyandb.image.tag=${banyandb_commit}" \
      --set banyandb.standalone.enabled=true \
      --set ui.enabled=false \
      --timeout 20m
    ;;

  horizon)
    image=$(val HORIZON_E2E_IMAGE)
    node_port=$(val HORIZON_E2E_NODE_PORT)
    user=$(val HORIZON_E2E_USER)
    hash=$(val HORIZON_E2E_PASSWORD_HASH)
    users="[{\"username\":\"${user}\",\"passwordHash\":\"${hash}\",\"roles\":[\"admin\"]}]"

    # `|` as the delimiter: the argon2 hash contains `/`, `+` and `=`, but
    # never a pipe.
    sed -e "s|__IMAGE__|${image}|" \
        -e "s|__NODE_PORT__|${node_port}|" \
        -e "s|__AUTH_USERS__|${users}|" \
        "${here}/cases/istio/horizon.yaml" | kubectl apply -f -
    ;;

  demo)
    ver=$(val ISTIO_VERSION)
    base="https://raw.githubusercontent.com/istio/istio/${ver}/samples/bookinfo"
    # bookinfo is a four-service call graph, which is what makes it worth
    # standing up: a two-service fixture cannot tell a real topology from a
    # single edge drawn twice.
    kubectl apply -f "${base}/platform/kube/bookinfo.yaml"
    kubectl apply -f "${base}/networking/bookinfo-gateway.yaml"
    ;;

  rover)
    # eBPF profiling and network profiling come from rover. Whether it is
    # deployed is decided in ONE place, shared with the verification that
    # depends on it — see profiling-enabled.sh.
    if ! bash "${here}/script/prepare/profiling-enabled.sh"; then
      echo "not deploying rover; profiling is out of this run"
      exit 0
    fi
    # A DaemonSet, not a chart — skywalking-helm publishes no rover chart.
    sed -e "s|__IMAGE__|$(val SW_ROVER_IMAGE)|" \
        "${here}/cases/istio/rover.yaml" | kubectl apply -f -
    kubectl -n "${NS}" rollout status daemonset/skywalking-rover --timeout=5m
    ;;

  *)
    echo "unknown stage: ${STAGE}" >&2
    exit 1
    ;;
esac
