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

import type { SsoProvider } from '@/api/client';

/**
 * How many sign-in providers get their own button before the rest fold away.
 *
 * Four is where a column of identical "Continue with …" buttons stops reading
 * as a short list of choices and starts reading as a wall.
 */
export const SSO_BUTTON_MAX = 4;

/**
 * Split the providers into the ones that get a button and the ones behind the
 * picker.
 *
 * THE SPLIT DEPENDS ON WHETHER THERE IS A PASSWORD FORM. A card that already
 * carries a username field, a password field and a Sign-in button has spent its
 * height; stacking provider buttons under that pushes the last of them off a
 * laptop screen. So when password login is available EVERY provider folds into
 * the picker, and the buttons-then-overflow layout belongs to the SSO-only card,
 * which has nothing else to show.
 *
 * ORDER IS THE CONFIGURATION'S. The server sends providers in the order
 * `auth.sso.providers` lists them and nothing here re-sorts them, which is what
 * lets an operator put the provider their people actually use first — and on an
 * SSO-only card with five or more, that order decides who gets a button at all.
 */
export function splitProviders(
  providers: readonly SsoProvider[],
  passwordLogin: boolean,
): { listed: SsoProvider[]; overflow: SsoProvider[] } {
  if (passwordLogin) return { listed: [], overflow: [...providers] };
  return {
    listed: providers.slice(0, SSO_BUTTON_MAX),
    overflow: providers.slice(SSO_BUTTON_MAX),
  };
}
