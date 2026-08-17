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
#     layer-template-push.sh <base-url> valid|bad-page|bad-order|read-back
#                            |stale-seed
#
# Publishes a layer template carrying extension pages and a custom menu
# order, and reads it back. Everything else that exercises this feature
# runs in the browser against a LOCAL draft, so this is the only coverage
# of the stored round trip: validation at the publish boundary, and the
# store returning the new fields intact.
#
# The key is `HORIZON_E2E_EXT`, which is not a bundled layer. That is what
# keeps the push safe: it creates a `remote-only` row, the state the
# sync-status assertions already treat as normal, instead of making a
# bundled row `diverged`. It also means OAP never lists the layer, so no
# sidebar or landing assertion is possible here — the resolver's ordering
# and landing rules are covered by unit tests, and the authoring flow by
# the `core` browser project.
#
# MUTATES OAP — only the `admin` case may call this.

set -eu

BASE="${1:?usage: layer-template-push.sh <base-url> <mode>}"
MODE="${2:?usage: layer-template-push.sh <base-url> <mode>}"

USER="${HORIZON_E2E_USER:-e2e}"
PASSWORD="${HORIZON_E2E_PASSWORD:-e2e-passw0rd}"
NAME="horizon.layer.HORIZON_E2E_EXT"
# A second layer, used only to leave a translation stranded. It is separate
# so the first one keeps its page for the browser to translate.
STALE_NAME="horizon.layer.HORIZON_E2E_STALE"

JAR=$(mktemp)
trap 'rm -f "${JAR}"' EXIT

curl -sSf -c "${JAR}" -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USER}\",\"password\":\"${PASSWORD}\"}" > /dev/null

# A Service extension page with a filter, an Instance page, and a menu
# order that interleaves them — the shape no bundled template has, so it
# is the only thing that proves the store carries these fields at all.
valid_content() {
  cat <<'JSON'
{
  "key": "HORIZON_E2E_EXT",
  "alias": "Horizon e2e ext",
  "components": { "service": true, "instances": true, "endpoints": true },
  "dashboards": {
    "service": [
      { "id": "svc-load", "type": "line", "title": "Load", "expressions": ["service_cpm"], "w": 6, "h": 4 }
    ],
    "instance": [
      { "id": "ins-load", "type": "line", "title": "Load", "expressions": ["service_instance_cpm"], "w": 6, "h": 4 }
    ],
    "endpoint": [
      { "id": "ep-load", "type": "line", "title": "Load", "expressions": ["endpoint_cpm"], "w": 6, "h": 4 }
    ]
  },
  "dashboardExtPages": {
    "service": [
      {
        "id": "agents",
        "name": "Agents",
        "serviceFilter": "/^agent::/",
        "widgets": [
          { "id": "ag-cpm", "type": "line", "title": "Agent load", "expressions": ["service_cpm"], "w": 6, "h": 4 }
        ]
      }
    ],
    "instance": [
      {
        "id": "runtime",
        "name": "Runtime",
        "instanceFilter": "/-/",
        "instanceAttributes": [{ "attribute": "language", "op": "exists" }],
        "widgets": [
          { "id": "rt-heap", "type": "line", "title": "Heap", "expressions": ["instance_jvm_memory_heap"], "w": 6, "h": 4 }
        ]
      }
    ],
    "endpoint": [
      {
        "id": "public",
        "name": "Public API",
        "serviceFilter": "/^agent::/",
        "widgets": [
          { "id": "pub-cpm", "type": "line", "title": "Calls", "expressions": ["endpoint_cpm"], "w": 6, "h": 4 }
        ]
      }
    ]
  },
  "menuOrder": ["service/agents", "service", "instance/runtime", "instance", "endpoint/public", "endpoint"]
}
JSON
}

# The two rejections are pushed SEPARATELY because they are caught at
# different bars, and the first stops the second from being reached:
# structure is parsed before anything cross-references it, so a payload
# carrying both is refused for the page id alone. That is the only order
# the checks can run in — a cross-reference needs parsed data — so the
# split is what lets each bar be pinned.

# Caught by the schema: a page id equal to a real layer route segment.
# Several sniffers test the whole path, so such an id changes unrelated
# behaviour rather than merely colliding.
bad_page_content() {
  cat <<'JSON'
{
  "key": "HORIZON_E2E_EXT",
  "alias": "Horizon e2e ext",
  "components": { "service": true },
  "dashboards": {
    "service": [
      { "id": "svc-load", "type": "line", "title": "Load", "expressions": ["service_cpm"], "w": 6, "h": 4 }
    ]
  },
  "dashboardExtPages": {
    "service": [
      { "id": "topology", "name": "Topology", "widgets": [] }
    ]
  }
}
JSON
}

# Caught by the cross-reference pass: structurally fine, but the order
# names a row this layer does not expose. The runtime skips such an entry
# rather than breaking, which is exactly why publish has to say so — a
# silently-ignored instruction is worse than a refused one.
bad_order_content() {
  cat <<'JSON'
{
  "key": "HORIZON_E2E_EXT",
  "alias": "Horizon e2e ext",
  "components": { "service": true },
  "dashboards": {
    "service": [
      { "id": "svc-load", "type": "line", "title": "Load", "expressions": ["service_cpm"], "w": 6, "h": 4 }
    ]
  },
  "menuOrder": ["service", "service/nope"]
}
JSON
}

# Push a refusal case and report the code plus whether the named problem
# reached the operator.
expect_refused() {
  curl -sS -b "${JAR}" -o /tmp/lt-bad.json -w '%{http_code}' \
    -X POST "${BASE}/api/admin/templates/save" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"${NAME}\",\"content\":${2}}"
}


# ── The stranded-translation fixture ────────────────────────────────────
#
# A leftover entry is what a language is left holding when the template
# drops something it had translated. Producing one needs a template edit,
# and the layer editor cannot make this one: its picker is the disk
# bundles plus the layers OAP reports, and this case runs no telemetry, so
# a remote-only layer never appears in it. The edit is therefore fixture
# setup, issued the same way an operator's push is; what the browser then
# asserts — the tag, the block, the cleanup — is all on screen.

stale_layer() {
  PAGES="$1"
  cat <<JSON
{
  "key": "HORIZON_E2E_STALE",
  "alias": "Horizon e2e stale",
  "components": { "service": true },
  "dashboards": {
    "service": [
      { "id": "svc-load", "type": "line", "title": "Load", "expressions": ["service_cpm"], "w": 6, "h": 4 }
    ]
  }${PAGES}
}
JSON
}

WITH_PAGE=',
  "dashboardExtPages": {
    "service": [
      {
        "id": "doomed",
        "name": "Doomed",
        "widgets": [
          { "id": "dm-cpm", "type": "line", "title": "Doomed load", "expressions": ["service_cpm"], "w": 6, "h": 4 }
        ]
      }
    ]
  }'

save_template() {
  curl -sSf -b "${JAR}" -X POST "${BASE}/api/admin/templates/save" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"${1}\",\"content\":${2}}" > /dev/null
}

case "${MODE}" in
  valid)
    # `-f` is deliberately absent: a 400 here is a failure to REPORT, not a
    # transport error to abort on, and the body is what says which rule
    # rejected it.
    CODE=$(curl -sS -b "${JAR}" -o /tmp/lt-save.json -w '%{http_code}' \
      -X POST "${BASE}/api/admin/templates/save" \
      -H 'Content-Type: application/json' \
      -d "{\"name\":\"${NAME}\",\"content\":$(valid_content)}")
    ISSUES=$(yq -r '.issues // [] | length' /tmp/lt-save.json 2>/dev/null || echo 0)
    echo "{\"httpCode\": ${CODE}, \"issueCount\": ${ISSUES}}"
    ;;
  bad-page)
    CODE=$(expect_refused page "$(bad_page_content)")
    CODEFIELD=$(yq -r '.code // ""' /tmp/lt-bad.json)
    REPORTS=$(yq -r '[.issues[]? | select(test("topology"))] | length > 0' /tmp/lt-bad.json)
    echo "{\"httpCode\": ${CODE}, \"code\": \"${CODEFIELD}\", \"namesTheProblem\": ${REPORTS}}"
    ;;
  bad-order)
    CODE=$(expect_refused order "$(bad_order_content)")
    CODEFIELD=$(yq -r '.code // ""' /tmp/lt-bad.json)
    REPORTS=$(yq -r '[.issues[]? | select(test("nope"))] | length > 0' /tmp/lt-bad.json)
    echo "{\"httpCode\": ${CODE}, \"code\": \"${CODEFIELD}\", \"namesTheProblem\": ${REPORTS}}"
    ;;
  stale-seed)
    # Publish the layer WITH its page, then translate that page's name into
    # zh-CN — a perfectly valid state, and the only one from which a
    # leftover can be created.
    save_template "${STALE_NAME}" "$(stale_layer "${WITH_PAGE}")"
    # TWO languages, because leftovers arrive per language and the cleanup
    # offers to sweep all of them — one language could not tell a sweep
    # from a single-row write.
    translate_page() {
      curl -sSf -b "${JAR}" -X POST "${BASE}/api/admin/templates/save-translation" \
        -H 'Content-Type: application/json' \
        -d "{\"name\":\"${STALE_NAME}\",\"locale\":\"${1}\",\"content\":{\"dashboardExtPages\":{\"service\":[{\"id\":\"doomed\",\"name\":\"${2}\"}]}}}" > /dev/null
    }
    translate_page zh-CN 注定
    translate_page ja 運命
    ZH=$(curl -sSf -b "${JAR}" "${BASE}/api/admin/templates/${STALE_NAME}/i18n/zh-CN" \
      | yq -P '.oap.dashboardExtPages.service[0].name')
    JA=$(curl -sSf -b "${JAR}" "${BASE}/api/admin/templates/${STALE_NAME}/i18n/ja" \
      | yq -P '.oap.dashboardExtPages.service[0].name')
    echo "{\"zh\": \"${ZH}\", \"ja\": \"${JA}\"}" | yq -P
    ;;
  read-back)
    # Read through the route the RENDERER calls, not an admin listing: it
    # is the stored template reaching the page that matters, and this is
    # the only endpoint that resolves a page id against it.
    PAGE=$(curl -sSf -b "${JAR}" \
      "${BASE}/api/layer/HORIZON_E2E_EXT/dashboard/config?scope=service&page=agents")
    DEFAULT=$(curl -sSf -b "${JAR}" \
      "${BASE}/api/layer/HORIZON_E2E_EXT/dashboard/config?scope=service")
    INSTANCE=$(curl -sSf -b "${JAR}" \
      "${BASE}/api/layer/HORIZON_E2E_EXT/dashboard/config?scope=instance&page=runtime")
    # The page's own filters survive the round trip. Read from the STORED
    # row, not from the menu: this case runs no telemetry, so OAP lists no
    # layer for this key and the menu has no entry to read them off.
    FILTERS=$(curl -sSf -b "${JAR}" "${BASE}/api/admin/templates/sync-status" \
      | yq -P '[.rows[] | select(.name == "horizon.layer.HORIZON_E2E_EXT") | .remote.configuration]
               | .[0] | from_json | .content.dashboardExtPages.instance[0]
               | {"name": .instanceFilter, "attr": .instanceAttributes[0].attribute}')
    # An id nothing declares must 404 rather than serve the default grid
    # under the page's URL.
    UNKNOWN=$(curl -sS -b "${JAR}" -o /dev/null -w '%{http_code}' \
      "${BASE}/api/layer/HORIZON_E2E_EXT/dashboard/config?scope=service&page=nope")
    printf '%s' "{
      \"pageWidgets\": $(printf '%s' "${PAGE}" | yq -r -o=json '[.widgets[].id]'),
      \"defaultWidgets\": $(printf '%s' "${DEFAULT}" | yq -r -o=json '[.widgets[].id]'),
      \"instancePageWidgets\": $(printf '%s' "${INSTANCE}" | yq -r -o=json '[.widgets[].id]'),
      \"unknownPageCode\": ${UNKNOWN},
      \"instanceFilters\": $(printf '%s' "${FILTERS}" | yq -o=json)
    }" | yq -P
    ;;
  *)
    echo "unknown mode: ${MODE}" >&2
    exit 2
    ;;
esac
