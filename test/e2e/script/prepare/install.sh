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

# Per-tool installer for the setup steps, same entry shape as
# apache/skywalking's test/e2e-v2/script/prepare/setup-e2e-shell/install.sh:
#
#     bash test/e2e/script/prepare/install.sh <tool>
#
# Deliberate difference from upstream: yq comes from a prebuilt release rather
# than `go install`. Upstream already needs a Go toolchain for its own build;
# this repo does not, and requiring one to run the UI's e2e locally on a
# laptop is a cost with no return.

set -eu

NAME="${1:?usage: install.sh <yq|swctl|kubectl|helm|istioctl|playwright>}"
BIN_DIR=/tmp/skywalking-infra-e2e/bin
mkdir -p "${BIN_DIR}"

here=$(cd "$(dirname "$0")/../.." && pwd)   # test/e2e
root=$(cd "${here}/../.." && pwd)           # repo root

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

case "${NAME}" in
  yq)
    if command -v yq > /dev/null 2>&1; then
      echo "yq already installed: $(command -v yq)"
      exit 0
    fi
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$(uname -m)" in
      x86_64 | amd64) arch=amd64 ;;
      arm64 | aarch64) arch=arm64 ;;
      *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
    esac
    curl -sSfLo "${BIN_DIR}/yq" \
      "https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_${os}_${arch}"
    chmod +x "${BIN_DIR}/yq"
    echo "installed yq to ${BIN_DIR}/yq"
    ;;

  swctl)
    # skywalking-cli publishes no binaries, so this builds from source like
    # upstream's installer does — it needs a Go toolchain on PATH. The version
    # is pinned in script/env; re-install when the installed one does not
    # match, otherwise a stale swctl from another project silently wins.
    ctl_commit=$(grep -E '^SW_CTL_COMMIT=' "${here}/script/env" | head -1 | cut -d= -f2-)
    # Check BIN_DIR before PATH: CI restores a cached binary straight into it,
    # and that restore must count as "already installed" regardless of whether
    # PATH has been exported yet. Building it takes about a minute, which is
    # the single largest fixed cost in the case.
    if [ -x "${BIN_DIR}/swctl" ] &&
       "${BIN_DIR}/swctl" --version 2>/dev/null | grep -q "${ctl_commit:0:7}"; then
      echo "swctl already at ${ctl_commit:0:7} (${BIN_DIR}/swctl)"
      exit 0
    fi
    if command -v swctl > /dev/null 2>&1 && swctl --version 2>/dev/null | grep -q "${ctl_commit:0:7}"; then
      echo "swctl already at ${ctl_commit:0:7}"
      exit 0
    fi
    tmp=/tmp/skywalking-infra-e2e/swctl
    mkdir -p "${tmp}" && cd "${tmp}"
    curl -sSkLo skywalking-cli.tar.gz \
      "https://github.com/apache/skywalking-cli/archive/${ctl_commit}.tar.gz"
    tar -zxf skywalking-cli.tar.gz --strip=1
    VERSION="${ctl_commit}" make install DESTDIR="${BIN_DIR}"
    echo "installed swctl to ${BIN_DIR}/swctl"
    ;;

  playwright)
    # Clear the fail-fast markers playwright.sh writes. They must not survive
    # from a previous run on the same machine, or the browser cases would
    # short-circuit to "failed" before running once.
    rm -f /tmp/skywalking-infra-e2e/playwright-*.failed

    # The suite runs in the pinned Ubuntu image, so nothing is installed on
    # the host — pre-pull it here to keep the pull out of the timed case.
    #
    # Best-effort on purpose: the pull is an optimisation, and a registry
    # hiccup must not fail a run whose image is already on the machine. Only
    # a genuinely ABSENT image is fatal, and it says so rather than letting
    # the browser case fail later with a confusing docker error.
    image=$(val SW_PLAYWRIGHT_IMAGE)
    if docker pull -q "${image}" > /dev/null 2>&1; then
      echo "browser image ready: ${image}"
    elif docker image inspect "${image}" > /dev/null 2>&1; then
      echo "browser image already present (pull failed, using local): ${image}"
    else
      echo "ERROR: ${image} is neither pullable nor present locally." >&2
      exit 1
    fi
    ;;

  kubectl)
    if command -v kubectl > /dev/null 2>&1; then
      echo "kubectl already installed: $(command -v kubectl)"
      exit 0
    fi
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$(uname -m)" in
      x86_64 | amd64) arch=amd64 ;;
      arm64 | aarch64) arch=arm64 ;;
      *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
    esac
    ver=$(val KUBECTL_VERSION)
    curl -sSfLo "${BIN_DIR}/kubectl" \
      "https://dl.k8s.io/release/${ver}/bin/${os}/${arch}/kubectl"
    chmod +x "${BIN_DIR}/kubectl"
    echo "installed kubectl ${ver} to ${BIN_DIR}/kubectl"
    ;;

  helm)
    if command -v helm > /dev/null 2>&1; then
      echo "helm already installed: $(command -v helm)"
      exit 0
    fi
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$(uname -m)" in
      x86_64 | amd64) arch=amd64 ;;
      arm64 | aarch64) arch=arm64 ;;
      *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
    esac
    ver=$(val HELM_VERSION)
    curl -sSfL "https://get.helm.sh/helm-${ver}-${os}-${arch}.tar.gz" \
      | tar -xz -C /tmp "${os}-${arch}/helm"
    mv "/tmp/${os}-${arch}/helm" "${BIN_DIR}/helm"
    chmod +x "${BIN_DIR}/helm"
    echo "installed helm ${ver} to ${BIN_DIR}/helm"
    ;;

  istioctl)
    ver=$(val ISTIO_VERSION)
    # Version-checked rather than presence-checked: istioctl must match the
    # control plane it installs, and a differently-versioned one left on the
    # machine by another project would install a mesh this case never pinned.
    if command -v istioctl > /dev/null 2>&1 &&
       istioctl version --remote=false 2>/dev/null | grep -q "${ver}"; then
      echo "istioctl ${ver} already installed: $(command -v istioctl)"
      exit 0
    fi
    curl -sSfL https://istio.io/downloadIstio | ISTIO_VERSION="${ver}" sh - > /dev/null
    mv "istio-${ver}/bin/istioctl" "${BIN_DIR}/istioctl"
    rm -rf "istio-${ver}"
    chmod +x "${BIN_DIR}/istioctl"
    echo "installed istioctl ${ver} to ${BIN_DIR}/istioctl"
    ;;

  *)
    echo "unknown tool: ${NAME}" >&2
    exit 1
    ;;
esac
