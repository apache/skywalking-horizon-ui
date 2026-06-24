/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Build OAP entity ids from names — the inverse of the UI's oalEntityId
 * decoder. Explore's Type/manual mode uses this so a query needs no layer
 * and no `listServices` round-trip: the operator types a service name +
 * the real/normal flag and we encode the id OAP would have minted.
 *
 * Mirrors OAP `IDManager` (verified against skywalking IDManager.java):
 *   service  = base64(name) + "." + (isReal ? "1" : "0")
 *   instance = serviceId   + "_" + base64(instanceName)
 *   endpoint = serviceId   + "_" + base64(endpointName)
 * Standard padded base64 over UTF-8 bytes (OAP's `Base64.getEncoder()`,
 * NOT url-safe — the id regex accepts `+/=`). A blank name encodes the
 * `_blank` sentinel, matching `Const.BLANK_ENTITY_NAME`.
 */

const BLANK_ENTITY_NAME = '_blank';

function encode(name: string): string {
  const n = name.trim().length === 0 ? BLANK_ENTITY_NAME : name;
  return Buffer.from(n, 'utf8').toString('base64');
}

export function buildServiceId(serviceName: string, isReal: boolean): string {
  return `${encode(serviceName)}.${isReal ? '1' : '0'}`;
}

export function buildInstanceId(serviceId: string, instanceName: string): string {
  return `${serviceId}_${encode(instanceName)}`;
}

export function buildEndpointId(serviceId: string, endpointName: string): string {
  return `${serviceId}_${encode(endpointName)}`;
}
