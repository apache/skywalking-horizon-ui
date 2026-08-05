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
#     profiling-enabled.sh   → exit 0 when the istio case should do profiling
#
# ONE answer, consulted by both halves of the opt: the rover deployment in
# istio-up.sh and the profiling verification in verify-profiling.yaml. They
# must never disagree — deploying rover but skipping its assertions wastes a
# deployment, and skipping rover while asserting on it fails a healthy run.
#
# Two ways to end up without profiling:
#
#   E2E_SKIP_PROFILING=true   asked for explicitly
#   not running on Linux      rover attaches eBPF probes to the HOST kernel,
#                             which on macOS is a VM it does not control. This
#                             one is not a preference and is not overridable:
#                             forgetting the flag on a laptop should not mean
#                             a rover install that cannot work, several
#                             minutes of helm timeout, and a red run that says
#                             nothing about Horizon.
#
# The reason is printed to stderr so the console says why, rather than leaving
# a silently narrower run looking like a full one.

set -eu

if [ "${E2E_SKIP_PROFILING:-}" = "true" ]; then
  echo "profiling OFF — E2E_SKIP_PROFILING=true" >&2
  exit 1
fi

kernel=$(uname -s)
if [ "${kernel}" != "Linux" ]; then
  echo "profiling OFF — rover needs a Linux kernel to attach eBPF probes to, this is ${kernel}" >&2
  exit 1
fi

echo "profiling ON — ${kernel} host, rover will be deployed" >&2
exit 0
