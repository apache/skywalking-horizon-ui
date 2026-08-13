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
#     collect-k8s.sh <output-dir>
#
# Cluster-side evidence for a failed kind case, gathered while the cluster is
# still up.
#
# infra-e2e already writes one log file per pod, which covers "what did this
# container print". It does NOT cover the questions a kind failure usually
# turns out to be: did the pod ever start, what did the scheduler say, did a
# container crash and restart, is the mesh actually injected. Those live in
# events, describe output, and the PREVIOUS container's log — none of which
# survive once the cluster is torn down.
#
# Never fails the job: this runs when something has already gone wrong, and a
# missing kubectl or an unreachable cluster must not replace the real error
# with an error from the collector.

set -u

OUT="${1:?usage: collect-k8s.sh <output-dir>}"
mkdir -p "${OUT}"

if ! command -v kubectl > /dev/null 2>&1; then
  echo "kubectl not on PATH — nothing to collect" > "${OUT}/UNAVAILABLE.txt"
  exit 0
fi
if ! kubectl cluster-info > "${OUT}/cluster-info.txt" 2>&1; then
  echo "no reachable cluster — it was probably torn down already" >> "${OUT}/cluster-info.txt"
  exit 0
fi

# Whole-cluster shape first: the one file to open before any other.
kubectl get pods -A -o wide          > "${OUT}/pods.txt"           2>&1
kubectl get events -A --sort-by=.lastTimestamp > "${OUT}/events.txt" 2>&1
kubectl get svc,deploy,ds,sts -A     > "${OUT}/workloads.txt"      2>&1
kubectl get nodes -o wide            > "${OUT}/nodes.txt"          2>&1

# Per pod: describe always, and the previous container's log when there was a
# restart — a CrashLoopBackOff's useful output is in the log that ALREADY
# ended, which the running-container log never shows.
kubectl get pods -A --no-headers -o custom-columns=':metadata.namespace,:metadata.name' 2>/dev/null |
  while read -r ns pod; do
    [ -z "${ns:-}" ] && continue
    dir="${OUT}/${ns}"
    mkdir -p "${dir}"
    kubectl -n "${ns}" describe pod "${pod}" > "${dir}/${pod}.describe.txt" 2>&1
    kubectl -n "${ns}" logs "${pod}" --all-containers --previous \
      > "${dir}/${pod}.previous.log" 2>/dev/null || rm -f "${dir}/${pod}.previous.log"
  done

# rover is the component this case exists to exercise and the one most likely
# to fail for host-specific reasons (kernel, BTF, privileges), so its log is
# pulled out where nobody has to go looking for it.
kubectl -n istio-system logs daemonset/skywalking-rover --all-containers --tail=-1 \
  > "${OUT}/rover.log" 2>&1 || true

# Mesh-side state. `proxy-status` is the fastest answer to "is the sidecar
# actually talking to istiod", which no pod log states directly.
if command -v istioctl > /dev/null 2>&1; then
  istioctl proxy-status > "${OUT}/istio-proxy-status.txt" 2>&1 || true
  istioctl analyze -A   > "${OUT}/istio-analyze.txt"      2>&1 || true
fi

echo "collected cluster diagnostics into ${OUT}"
exit 0
