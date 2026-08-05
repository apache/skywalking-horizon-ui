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
#     deployment-up.sh <skywalking|collector|horizon|app>
#
# One stage of the deployment fixture per invocation, so infra-e2e reports
# which stage failed rather than one opaque "setup failed".

set -eu

STAGE="${1:?usage: deployment-up.sh <skywalking|collector|horizon|app>}"

here=$(cd "$(dirname "$0")/../.." && pwd)   # test/e2e

# A value already exported in the caller's shell wins over script/env.
val() {
  eval "local override=\${$1:-}"
  if [ -n "${override}" ]; then
    echo "${override}"
    return
  fi
  grep -E "^$1=" "${here}/script/env" | head -1 | cut -d= -f2-
}

NS=skywalking

case "${STAGE}" in
  skywalking)
    chart=$(val SW_HELM_CHART_COMMIT)
    oap_commit=$(val SW_OAP_COMMIT)
    banyandb_commit=$(val SW_BANYANDB_COMMIT)

    # BanyanDB in CLUSTER mode with FODC, which is the whole point of this
    # case: a standalone node has no roles to draw and no FODC to report
    # them, so the Deployment tab would render a single box and prove
    # nothing. Two liaisons and two data nodes is the smallest shape that
    # still has a role split for the tab to group by.
    #
    # One release rather than two: the chart wires OAP's storage at the
    # subchart's `-grpc` service, so installing BanyanDB separately would
    # mean re-deriving that address by hand.
    helm -n "${NS}" install skywalking \
      oci://ghcr.io/apache/skywalking-helm/skywalking-helm \
      --version "0.0.0-${chart}" \
      --create-namespace \
      --set fullnameOverride=skywalking \
      --set oap.replicas=1 \
      --set oap.image.repository=ghcr.io/apache/skywalking/oap \
      --set "oap.image.tag=${oap_commit}" \
      --set oap.storageType=banyandb \
      --set oap.env.SW_HEALTH_CHECKER=default \
      --set elasticsearch.enabled=false \
      --set banyandb.enabled=true \
      --set banyandb.fullnameOverride=skywalking-banyandb \
      --set banyandb.image.repository=ghcr.io/apache/skywalking-banyandb \
      --set "banyandb.image.tag=${banyandb_commit}" \
      --set banyandb.standalone.enabled=false \
      --set banyandb.cluster.enabled=true \
      --set banyandb.cluster.fodc.enabled=true \
      --set banyandb.cluster.liaison.replicas=2 \
      --set banyandb.cluster.data.nodeTemplate.replicas=2 \
      --set ui.enabled=false \
      --timeout 20m
    ;;

  collector)
    image=$(val SW_OTEL_COLLECTOR_IMAGE)
    cluster=$(val BANYANDB_E2E_CLUSTER)
    sed -e "s|__IMAGE__|${image}|" \
        -e "s|__CLUSTER__|${cluster}|" \
        "${here}/cases/deployment/otel-collector.yaml" | kubectl apply -f -
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
        -e "s|istio-system|${NS}|g" \
        "${here}/cases/deployment/horizon.yaml" | kubectl apply -f -
    ;;

  app)
    # A load source, not a subject: the BANYANDB layer's metrics come from
    # BanyanDB itself, and BanyanDB only has anything to report while OAP is
    # writing to it. The demo provider gives it a steady stream to store.
    image=$(val SW_E2E_SERVICE_COMMIT)
    sed -e "s|__IMAGE__|horizon-e2e-demo-provider:${image}|" \
        -e "s|__TRAFFIC_IMAGE__|$(val TRAFFIC_GEN_IMAGE)|" \
        "${here}/cases/deployment/app.yaml" | kubectl apply -f -
    ;;

  *)
    echo "unknown stage: ${STAGE}" >&2
    exit 1
    ;;
esac
