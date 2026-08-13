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
#     alarm-count.sh <base-url>
#
# The alarm routes take an explicit epoch-millisecond window rather than a
# rolling `windowMinutes`, so the bounds have to be computed per call — which
# a static verify-case URL cannot do.

set -eu

BASE="${1:?usage: alarm-count.sh <base-url>}"
END=$(node -e 'process.stdout.write(String(Date.now()))')
START=$(node -e 'process.stdout.write(String(Date.now() - 60 * 60 * 1000))')

bash "$(dirname "$0")/horizon-get.sh" "${BASE}" "/api/alarms/count?startTime=${START}&endTime=${END}"
