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


import logging
import socketserver
from http.server import BaseHTTPRequestHandler

import httpx
from openai import OpenAI
from opentelemetry import trace

# One log line per LLM call, exported over OTLP with the rest of the app's
# telemetry. It is written from the HTTP client's request hook, which runs
# inside the instrumentation's LLM span, so the record carries that span's
# trace id and span id, which OAP stores with the line. The text names the
# trace id too, so a spec can tell the line is this trace's own.
log = logging.getLogger('e2e.openai-call')
log.setLevel(logging.INFO)


def log_llm_call(request):
    ctx = trace.get_current_span().get_span_context()
    if ctx.is_valid:
        log.info('calling the LLM at %s trace_id=%s', request.url.path, trace.format_trace_id(ctx.trace_id))


client = OpenAI(
    timeout=120.0,
    http_client=httpx.Client(timeout=120.0, event_hooks={'request': [log_llm_call]}),
)

class AIRequestHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        try:
            response = client.chat.completions.create(
                model="gpt-4.1-mini",
                messages=[{"role": "user", "content": "Tell me a joke."}]
            )
            content = response.choices[0].message.content
            self.reply(200, f'{{"response": "{content}"}}')
        except Exception as e:
            self.reply(500, f'{{"error": "{str(e)}"}}')

    # Upstream's copy ends the body by closing the connection. With a
    # Content-Length a client on Docker Desktop's published port sees the end
    # of the body too: that forwarder was observed not to pass the server's
    # close through, so every request from the host ran to the client's own
    # timeout while loopback and the compose network answered in milliseconds.
    def reply(self, status, body):
        payload = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        self.do_GET()

PORT = 9091

if __name__ == '__main__':
    with socketserver.TCPServer(("", PORT), AIRequestHandler) as httpd:
        print(f"serving at port {PORT}")
        httpd.serve_forever()