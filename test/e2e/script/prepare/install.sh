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

NAME="${1:?usage: install.sh <yq|swctl|playwright>}"
BIN_DIR=/tmp/skywalking-infra-e2e/bin
mkdir -p "${BIN_DIR}"

here=$(cd "$(dirname "$0")/../.." && pwd)   # test/e2e
root=$(cd "${here}/../.." && pwd)           # repo root

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
    image=$(grep -E '^SW_PLAYWRIGHT_IMAGE=' "${here}/script/env" | head -1 | cut -d= -f2-)
    docker pull -q "${image}" > /dev/null
    echo "browser image ready: ${image}"
    ;;

  *)
    echo "unknown tool: ${NAME}" >&2
    exit 1
    ;;
esac
