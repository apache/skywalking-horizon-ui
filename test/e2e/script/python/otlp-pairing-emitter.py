#  Licensed to the Apache Software Foundation (ASF) under one or more
#  contributor license agreements.  See the NOTICE file distributed with
#  this work for additional information regarding copyright ownership.
#  The ASF licenses this file to You under the Apache License, Version 2.0
#  (the "License"); you may not use this file except in compliance with
#  the License.  You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.

"""OTLP spans for the TAL debugger and the OTLP pairing page.

Every interval, one trace across two services that report service.layer=OTLP_GENERAL: the frontend's SERVER span,
its CLIENT call to the backend, and the backend's SERVER span under that call, whose parent ran in another process.
OAP's shipped otlp-general rule runs on each span; the CLIENT span sends the caller half of a network alias and the
backend's SERVER span the callee half, so the trace's owner matches the two and the pairing page lists
e2e-pairing-backend:8080 matched to e2e-pairing-backend. The same trace as OAP's own TAL OTLP e2e emits.
"""

import os
import time

from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import NonRecordingSpan, SpanContext, SpanKind, TraceFlags, set_span_in_context

ENDPOINT = os.environ.get("OTLP_ENDPOINT", "http://oap:11800")
INTERVAL_S = float(os.environ.get("EMITTER_INTERVAL_S", "1"))


def tracer(service):
    provider = TracerProvider(resource=Resource.create({
        "service.name": service,
        "service.instance.id": service + "-1",
        "service.layer": "OTLP_GENERAL",
    }))
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=ENDPOINT, insecure=True), schedule_delay_millis=1000))
    return provider.get_tracer("horizon-e2e-pairing-emitter")


def main():
    frontend = tracer("e2e-pairing-frontend")
    backend = tracer("e2e-pairing-backend")
    while True:
        with frontend.start_as_current_span("GET /checkout", kind=SpanKind.SERVER, attributes={
            "http.request.method": "GET", "url.path": "/checkout", "http.response.status_code": 200,
        }):
            with frontend.start_as_current_span("GET", kind=SpanKind.CLIENT, attributes={
                "http.request.method": "GET", "server.address": "e2e-pairing-backend", "server.port": 8080,
                "url.full": "http://e2e-pairing-backend:8080/stock", "http.response.status_code": 200,
            }) as call:
                caller = call.get_span_context()
                # The backend continues the trace from the call's propagated context, as a remote parent.
                remote = set_span_in_context(NonRecordingSpan(SpanContext(
                    caller.trace_id, caller.span_id, is_remote=True, trace_flags=TraceFlags(TraceFlags.SAMPLED))))
                with backend.start_as_current_span("GET /stock", context=remote, kind=SpanKind.SERVER, attributes={
                    "http.request.method": "GET", "url.path": "/stock", "http.response.status_code": 200,
                    "server.address": "e2e-pairing-backend", "server.port": 8080,
                }):
                    time.sleep(0.01)
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    main()
