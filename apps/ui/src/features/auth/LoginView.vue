<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
// Full "SkyWalking" wordmark + moon, white-fill. The login page's
// backdrop is always the dark canyon photo, so the logo stays white
// regardless of which theme the operator has picked for the post-
// login app. (The sidebar logo DOES swap to blue on light themes —
// see AppSidebar.vue — because that surface follows the theme.)
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import loginBgUrl from '@/assets/login-bg.jpg?url';
import { useAuthStore } from '@/state/auth';
import { bff, API_BASE, type SsoProvider } from '@/api/client';
import type { AuthHealth } from '@/api/scopes/admin-auth';
import LocaleChip from '@/shell/LocaleChip.vue';
import Icon from '@/components/icons/Icon.vue';

// `useScope: 'global'` binds `t` to the global i18n instance so a
// `locale` change in the top-bar / login locale chip reactively
// re-renders this view. Without it, `<script setup>` components get a
// component-scoped i18n whose `locale` ref is separate from the global
// one — the chrome flips language only on a remount.
const { t } = useI18n({ useScope: 'global' });

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const submitting = ref(false);

/** Sign-in providers this deployment configures. Empty is the common case and
 *  renders nothing — password login is unaffected either way. */
const ssoProviders = ref<SsoProvider[]>([]);
/** Which provider the picker has selected. Seeded from the first one the
 *  server lists, so the button is never wired to nothing. */
const ssoChoice = ref('');
const chosenIcon = computed(() => ssoProviders.value.find((p) => p.id === ssoChoice.value)?.icon ?? '');
const chosenName = computed(
  () => ssoProviders.value.find((p) => p.id === ssoChoice.value)?.displayName ?? '',
);

/** Provider picker. Open state lives here rather than in a shared primitive:
 *  the typeahead one carries a search box, which is noise for the two or three
 *  providers a deployment actually configures. */
const pickRoot = ref<HTMLElement | null>(null);
const pickOpen = ref(false);
const pickActive = ref(0);

function openPick(): void {
  pickOpen.value = true;
  pickActive.value = Math.max(0, ssoProviders.value.findIndex((p) => p.id === ssoChoice.value));
}
function choose(id: string): void {
  ssoChoice.value = id;
  pickOpen.value = false;
}
/**
 * Every key for this control, in one handler on the trigger itself.
 *
 * It must preventDefault on the keys it uses: the trigger is a <button>, so
 * Enter and Space natively fire a click, which would toggle the menu shut in
 * the same keystroke that was meant to choose from it.
 */
function onTriggerKey(e: KeyboardEvent): void {
  const n = ssoProviders.value.length;
  if (!n) return;
  if (e.key === 'Escape') { pickOpen.value = false; return; }
  if (!pickOpen.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { openPick(); e.preventDefault(); }
    return;
  }
  if (e.key === 'ArrowDown') { pickActive.value = (pickActive.value + 1) % n; e.preventDefault(); return; }
  if (e.key === 'ArrowUp') { pickActive.value = (pickActive.value - 1 + n) % n; e.preventDefault(); return; }
  if (e.key === 'Enter' || e.key === ' ') {
    const p = ssoProviders.value[pickActive.value];
    if (p) choose(p.id);
    e.preventDefault();
  }
}
/** A click anywhere else closes it — the trigger is not a modal. */
function onDocClick(e: MouseEvent): void {
  if (pickOpen.value && pickRoot.value && !pickRoot.value.contains(e.target as Node)) pickOpen.value = false;
}
/** A full-page navigation, so it cannot go through the API client — but it
 *  must carry the same base, or a Horizon served under a gateway prefix sends
 *  the operator to the gateway's root instead of to Horizon. */
const ssoHref = (id: string): string =>
  `${API_BASE}/api/auth/oidc/start?provider=${encodeURIComponent(id)}&next=${encodeURIComponent(ssoNext.value)}`;
/** Where to land after the round trip. Same as the password path's redirect,
 *  so a deep link survives an SSO login too. */
const ssoNext = computed(() => {
  const raw = typeof route.query.redirect === 'string' ? route.query.redirect : '';
  return raw && raw !== '/login' ? raw : '/';
});
/**
 * The provider round trip cannot report through the SPA's fetch layer — it
 * ends in a browser redirect — so the callback puts a reason in the URL and
 * this turns it into a sentence WE wrote — never the raw parameter.
 */
const SSO_ERRORS: Record<string, () => string> = {
  sso_not_configured: () => t('Single sign-on is not configured on this server.'),
  unknown_provider: () => t('That sign-in provider is not configured.'),
  provider_unreachable: () => t('The sign-in provider could not be reached. Try again, or use a password.'),
  login_expired: () => t('That sign-in took too long. Please try again.'),
  state_mismatch: () => t('The sign-in could not be verified. Please try again.'),
  no_code: () => t('The sign-in provider returned no authorization code.'),
  no_email: () => t('The sign-in provider did not supply an email address.'),
  email_not_verified: () => t('That account has no verified email address.'),
  domain_not_allowed: () => t('That email domain is not allowed to sign in here.'),
  no_roles: () => t('Your account has no role in Horizon. Ask an administrator to grant one.'),
  access_denied: () => t('You cancelled the sign-in.'),
  sso_failed: () => t('Single sign-on failed. The server log has the reason the provider gave.'),
};
const ssoError = computed(() => {
  const raw = typeof route.query.sso_error === 'string' ? route.query.sso_error : '';
  if (!raw) return '';
  // Only ever a sentence WE wrote. `?sso_error=` is a query parameter, so
  // anyone can put a link in front of an operator that renders whatever text
  // they like on Horizon's own login page — "Your session expired, call
  // +1-555…" is a convincing lure on a URL that really is ours. An
  // unrecognised code becomes the generic sentence, with the code as data so
  // it stays diagnosable.
  return SSO_ERRORS[raw]?.() ?? t('Single sign-on failed ({code}).', { code: raw.slice(0, 40) });
});

const health = ref<AuthHealth | null>(null);
let pingTimer: ReturnType<typeof setInterval> | null = null;

async function refreshHealth(): Promise<void> {
  try {
    health.value = await bff.adminAuth.health();
  } catch {
    /* swallow — the login form remains usable; status pill stays as-is */
  }
}
onMounted(() => {
  void bff.oidc.providers().then((r) => {
    ssoProviders.value = r.providers;
    ssoChoice.value = r.providers[0]?.id ?? '';
  }).catch(() => {
    /* swallow — password login stays usable if the probe fails */
  });
  void refreshHealth();
  pingTimer = setInterval(() => void refreshHealth(), 5000);
  document.addEventListener('click', onDocClick);
});
onUnmounted(() => {
  if (pingTimer) clearInterval(pingTimer);
  document.removeEventListener('click', onDocClick);
});

const statusKind = computed<'ok' | 'err' | 'info' | 'warn' | null>(() => {
  if (!health.value) return null;
  if (!health.value.configured) return 'warn';
  if (health.value.backend === 'local') return 'ok';
  if (health.value.backend === 'ldap') return health.value.ldap?.reachable ? 'ok' : 'err';
  return 'info';
});
const statusLabel = computed<string>(() => {
  if (!health.value) return t('Checking auth backend…');
  if (!health.value.configured) return t('Auth not configured');
  if (health.value.backend === 'local') return t('Local users');
  if (health.value.backend === 'ldap') {
    return health.value.ldap?.reachable ? t('LDAP reachable') : t('LDAP unreachable');
  }
  return t('Unknown backend');
});
const statusHost = computed<string | null>(() => health.value?.ldap?.host ?? null);
const unconfigured = computed<boolean>(() => health.value !== null && !health.value.configured);
const setupHint = computed<string>(() => health.value?.setupHint ?? '');
const currentYear = new Date().getFullYear();

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const ok = await auth.login(username.value, password.value);
    if (ok) {
      const raw = typeof route.query.redirect === 'string' ? route.query.redirect : '';
      // `||` not `??`: landingRoute can be an empty string, which would
      // otherwise push('') → an empty address. Belt-and-suspenders final
      // fallback too.
      const landing = auth.user?.landingRoute || '/';
      const redirect = (raw && raw !== '/login' ? raw : landing) || '/';
      await router.push(redirect);
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="stage" :style="{ backgroundImage: `url(${loginBgUrl})` }">
    <!-- Desaturate + dim the photo so the UI floats above. -->
    <div class="dim" />
    <!-- Color wash tying the canyon orange to the brand palette. -->
    <div class="wash" />
    <!-- Subtle grid overlay. -->
    <div class="grid" />

    <!-- Top: SkyWalking logo + Horizon wordmark + inline auth-status pill. -->
    <header class="top">
      <span class="brand">
        <!-- eslint-disable-next-line vue/no-v-html -- build-time `?raw` import of a bundled SVG constant; no runtime input reaches it, and scripts/check-security.mjs scans the ?raw set for active content -->
        <span class="brand-logo" v-html="logoSw" />
        <span class="brand-sep" aria-hidden="true" />
        <span class="brand-name">{{ t('Horizon') }}</span>
      </span>
      <span class="top-right">
        <span v-if="statusKind" class="status-pill" :class="`pill-${statusKind}`">
          <span class="status-dot" />
          <b>{{ statusLabel }}</b>
          <template v-if="statusHost">
            <span class="status-sep">·</span>
            <code class="status-host">{{ statusHost }}</code>
          </template>
        </span>
        <!-- Pre-auth locale picker. Same component the topbar uses;
             writes localStorage so the choice survives logout and
             carries through to the post-login session. -->
        <LocaleChip />
      </span>
    </header>

    <!-- Centered glass card. -->
    <main class="center">
      <form class="card" @submit.prevent="submit">
        <div class="card-head">
          <h1>{{ t('Welcome to SkyWalking') }}</h1>
        </div>

        <!-- First-touch banner: auth isn't wired yet. The BFF still
             boots in this state; this banner is what the operator sees
             instead of a crashed container. -->
        <div v-if="unconfigured" class="setup-banner" role="alert">
          <div class="setup-banner-head">
            <span class="setup-banner-icon" aria-hidden="true">⚙︎</span>
            <b>{{ t('Auth not configured') }}</b>
          </div>
          <p class="setup-banner-body">{{ setupHint }}</p>
          <p class="setup-banner-foot">
            {{ t('See') }}
            <a
              href="https://skywalking.apache.org/docs/skywalking-horizon-ui/next/en/setup/auth/"
              target="_blank"
              rel="noreferrer noopener"
            >{{ t('Setup → Auth') }}</a>
            {{ t('for backend selection, user / role schema, and an LDAP example.') }}
          </p>
        </div>

        <label class="field">
          <span>{{ t('Username') }}</span>
          <input
            v-model="username"
            type="text"
            name="username"
            autocomplete="username"
            autofocus
            :disabled="unconfigured"
            required
          />
        </label>

        <label class="field">
          <span>{{ t('Password') }}</span>
          <input
            v-model="password"
            type="password"
            name="password"
            autocomplete="current-password"
            :disabled="unconfigured"
            required
          />
        </label>

        <div v-if="auth.loginError" class="error">{{ auth.loginError }}</div>
        <div v-if="ssoError" class="error">{{ ssoError }}</div>

        <button class="sign-in" type="submit" :disabled="submitting || unconfigured">
          {{ unconfigured ? t('Sign in disabled') : (submitting ? t('Signing in…') : t('Sign in')) }}
        </button>

        <!-- Single sign-on. Rendered only when the deployment configures a
             provider, and each button is one config entry — nothing here knows
             which vendor it is. A full-page navigation, not a fetch: the
             provider answers with a redirect the browser must follow. -->
        <template v-if="ssoProviders.length">
          <div class="sso-sep"><span>{{ t('or') }}</span></div>
          <!-- One provider is a button; several are a picker. A column of
               buttons stops reading as a choice once it is more than two or
               three, and a deployment fronting several directories can easily
               have more. -->
          <a
            v-if="ssoProviders.length === 1"
            class="sso"
            :href="ssoHref(ssoProviders[0].id)"
          >
            <!-- Operator-supplied `data:` URI, or nothing. Horizon ships no
                 vendor marks — see auth.sso.providers[].icon. Rendered as an
                 image, never inlined as markup. -->
            <img v-if="ssoProviders[0].icon" class="sso-icon" :src="ssoProviders[0].icon" alt="" />
            {{ t('Continue with {provider}', { provider: ssoProviders[0].displayName }) }}
          </a>
          <!-- A native <select> renders its list through the OS, which ignores
               this page's palette entirely — on macOS it drops a light-grey
               popup onto a dark card. This is the same control drawn in our
               own vocabulary: a listbox we style, plus an arrow to go. -->
          <div v-else ref="pickRoot" class="sso-pick">
            <button
              type="button"
              class="sso-trigger"
              role="combobox"
              aria-haspopup="listbox"
              :aria-expanded="pickOpen"
              aria-controls="sso-listbox"
              :aria-activedescendant="pickOpen ? `sso-opt-${pickActive}` : undefined"
              :aria-label="t('Sign-in provider')"
              @click="pickOpen ? (pickOpen = false) : openPick()"
              @keydown="onTriggerKey"
            >
              <img v-if="chosenIcon" class="sso-icon" :src="chosenIcon" alt="" />
              <span class="sso-trigger-label">{{ chosenName }}</span>
              <Icon name="caret" :size="14" class="sso-caret" :class="{ up: pickOpen }" />
            </button>
            <ul v-if="pickOpen" id="sso-listbox" class="sso-menu" role="listbox">
              <li
                v-for="(p, i) in ssoProviders"
                :id="`sso-opt-${i}`"
                :key="p.id"
                role="option"
                :aria-selected="p.id === ssoChoice"
                :class="{ on: p.id === ssoChoice, active: i === pickActive }"
                @click="choose(p.id)"
                @mouseenter="pickActive = i"
              >
                <img v-if="p.icon" class="sso-icon" :src="p.icon" alt="" />
                <span>{{ p.displayName }}</span>
                <Icon v-if="p.id === ssoChoice" name="chev" :size="13" class="sso-tick" />
              </li>
            </ul>
            <!-- The arrow IS the action: the dropdown picks, this goes. -->
            <a class="sso-go" :href="ssoHref(ssoChoice)" :aria-label="t('Continue')" :title="t('Continue')">
              <Icon name="chev" :size="18" />
            </a>
          </div>
        </template>
      </form>
    </main>

    <!-- Footer: Apache copyright + trademark notice. -->
    <footer class="foot">
      <div class="foot-legal">
        <div>
          {{ t('© {from} – {to} The Apache Software Foundation.', { from: 2017, to: currentYear }) }}
          {{ t('All Rights Reserved.') }}
        </div>
        <div class="foot-tm">
          {{ t('Apache SkyWalking, SkyWalking, Apache, the Apache feather logo, and the Apache SkyWalking project logo are either registered trademarks or trademarks of the Apache Software Foundation.') }}
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  min-height: 100vh;
  /* Use 100dvh on mobile (dynamic viewport, accounts for safari URL bar)
     and fall back to 100vh elsewhere. */
  min-height: 100dvh;
  width: 100%;
  overflow: hidden;
  color: var(--sw-fg-0);
  font-family: var(--sw-sans);
  background-size: cover;
  background-position: center;
  background-color: var(--sw-bg-0);
  /* Flex column lays out top / main / footer in flow, so nothing
     overlaps on short viewports and the card stays centered while
     real estate is available. */
  display: flex;
  flex-direction: column;
}
.dim,
.wash,
.grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.dim {
  background: rgba(10, 13, 18, 0.62);
  backdrop-filter: saturate(0.55) blur(1px);
  -webkit-backdrop-filter: saturate(0.55) blur(1px);
}
.wash {
  /* Viewport-relative sizes so the orange/purple washes scale on
     ultra-wide and ultra-tall screens (5K, portrait phones). Caps with
     pixel max so they don't get cartoonish on a 30" 5120-wide. */
  background:
    radial-gradient(min(60vw, 1200px) min(60vh, 800px) at 20% 30%, rgba(249, 115, 22, 0.18), transparent 60%),
    radial-gradient(min(50vw, 900px) min(50vh, 700px) at 80% 75%, rgba(168, 85, 247, 0.14), transparent 60%),
    linear-gradient(180deg, rgba(10, 13, 18, 0) 30%, rgba(10, 13, 18, 0.6) 100%);
}
.grid {
  opacity: 0.1;
  mix-blend-mode: overlay;
  background:
    linear-gradient(var(--sw-line-2) 1px, transparent 1px) 0 0 / 96px 96px,
    linear-gradient(90deg, var(--sw-line-2) 1px, transparent 1px) 0 0 / 96px 96px;
}

/* ── Top brand bar ────────────────────────────────────────────── */
.top {
  position: relative;
  z-index: 2;
  padding: 20px 28px;
  display: flex;
  align-items: center;
  gap: 14px;
  /* Wrap on narrow viewports so the status pill sits below the brand
     rather than clipping off-screen. */
  flex-wrap: wrap;
}
.top-right {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.brand-logo {
  display: inline-flex;
  color: var(--sw-fg-0);
}
.brand-logo :deep(svg) {
  height: 32px;
  width: auto;
  display: block;
  filter: drop-shadow(0 8px 20px rgba(0, 0, 0, 0.45));
}
.brand-sep {
  width: 1px;
  height: 22px;
  background: linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.28) 50%,
    rgba(255, 255, 255, 0) 100%
  );
}
.brand-name {
  /* Inter at a relaxed wordmark size: large enough to read as the
     product name, tight letter-spacing so it sits comfortably next to
     the SkyWalking mark without becoming louder than it. */
  font-family: var(--sw-sans);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.4px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  /* Cap so a long LDAP host doesn't push the whole bar wide on
     narrow screens; the host code below ellipsizes. */
  max-width: min(420px, calc(100vw - 200px));
  min-width: 0;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.pill-ok {
  color: var(--sw-ok);
  background: rgba(34, 197, 94, 0.15);
  border-color: rgba(34, 197, 94, 0.5);
}
.pill-err {
  color: var(--sw-err);
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.5);
}
.pill-err .status-dot {
  box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45);
  animation: pulse 1.4s ease-out infinite;
}
.pill-info {
  color: var(--sw-info);
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.5);
}
.pill-warn {
  color: var(--sw-warn, #f59e0b);
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.5);
}
.pill-warn .status-dot {
  box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.45);
  animation: pulse-warn 1.6s ease-out infinite;
}
@keyframes pulse-warn {
  0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.45); }
  80% { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0); }
  100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
}

/* First-touch setup-required banner — appears above the form fields
   when `/api/auth/health` reports `configured: false`. */
.setup-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  margin: 0 0 4px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: var(--sw-fg-0);
  font-size: 13px;
  line-height: 1.4;
}
.setup-banner-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--sw-warn, #f59e0b);
}
.setup-banner-icon {
  font-size: 14px;
}
.setup-banner-body {
  margin: 0;
  color: var(--sw-fg-1);
}
.setup-banner-foot {
  margin: 0;
  color: var(--sw-fg-2);
  font-size: 12px;
}
.setup-banner-foot a {
  color: var(--sw-accent);
  text-decoration: underline;
}
.field input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.sign-in:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45); }
  80% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
  100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
}
.status-sep {
  color: rgba(255, 255, 255, 0.4);
}
.status-host {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: rgba(255, 255, 255, 0.7);
  /* Ellipsize when the host string is longer than the pill allows. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ── Centered glass card ──────────────────────────────────────── */
.center {
  position: relative;
  z-index: 2;
  flex: 1;
  /* No `min-height: 100vh` — the flex column already gives `main` the
     remaining space between top + footer, so the card centers in
     whatever rectangle is left without forcing scrolling on short
     viewports. */
  display: grid;
  place-items: center;
  padding: 24px;
}
.card {
  width: 380px;
  max-width: 100%;
  padding: 22px;
  background: rgba(15, 19, 26, 0.55);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.card-head {
  margin-bottom: 20px;
}
.card-head h1 {
  margin: 0;
  font-family: var(--sw-sans);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.4px;
  line-height: 1.2;
  color: #fff;
}

.field {
  display: block;
  margin-bottom: 12px;
}
.field span {
  display: block;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(232, 236, 243, 0.55);
  margin-bottom: 5px;
  font-weight: 600;
}
.field input {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #fff;
  font-family: var(--sw-mono);
  font-size: 13px;
  outline: none;
  transition: border-color 0.1s;
}
.field input:focus {
  border-color: var(--sw-accent-line);
  background: rgba(255, 255, 255, 0.07);
}
.error {
  margin: 8px 0 12px;
  padding: 8px 10px;
  background: rgba(239, 68, 68, 0.12);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 6px;
  font-size: 12px;
}
.sign-in {
  width: 100%;
  height: 38px;
  margin-top: 4px;
  /* Gradient stops both derived from --sw-accent so the button tracks
   * the operator's theme — Obsidian gets purple→darker-purple,
   * Daybreak gets dawn-pink→darker-dawn-pink, etc. The dark stop is
   * 14% darker than the accent via color-mix; if the runtime is too
   * old for color-mix the fallback flat accent below still works. */
  background: var(--sw-accent);
  background: linear-gradient(
    180deg,
    var(--sw-accent),
    color-mix(in srgb, var(--sw-accent) 86%, black 14%)
  );
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  box-shadow:
    0 8px 20px -8px var(--sw-accent),
    inset 0 1px 0 rgba(255, 255, 255, 0.18);
  transition: filter 0.1s, transform 0.05s;
}
.sign-in:hover:not(:disabled) {
  filter: brightness(1.08);
}
.sign-in:active:not(:disabled) {
  transform: translateY(1px);
}
.sign-in:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  filter: grayscale(0.3);
}

/* ── Footer ───────────────────────────────────────────────────── */
.foot {
  position: relative;
  z-index: 2;
  padding: 14px 28px 16px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  color: rgba(255, 255, 255, 0.45);
  font-size: 10.5px;
  flex-wrap: wrap;
}
.foot-legal {
  /* Single column now that the Horizon mark moved up top. Centered so
     the copyright reads as page chrome rather than a left-anchored
     credit competing with the form. */
  margin: 0 auto;
  text-align: center;
  max-width: 820px;
  line-height: 1.5;
}
.foot-tm {
  margin-top: 2px;
  color: rgba(255, 255, 255, 0.4);
}
/* Hide the trademark prose on very short viewports so the card has
   full breathing room. The copyright year line stays. */
@media (max-height: 520px) {
  .foot-tm { display: none; }
}
/* On very narrow viewports the brand bar can become the dominant
   element; trim its padding so the card has more vertical room. */
@media (max-width: 480px) {
  .top { padding: 14px 16px; gap: 10px; }
  .center { padding: 16px; }
  .card { padding: 18px; }
  .brand-tag { display: none; }
}

/* Single sign-on buttons, quieter than the primary Sign in. */
.sso-sep {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 0 12px;
  color: var(--text-3, #7b879b);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.sso-sep::before,
.sso-sep::after {
  content: '';
  flex: 1;
  height: 1px;
  background: rgb(255 255 255 / 14%);
}
.sso {
  display: block;
  margin-top: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 20%);
  background: rgb(255 255 255 / 6%);
  color: var(--text-1, #e8edf5);
  font-size: 13px;
  font-weight: 600;
  text-align: center;
  text-decoration: none;
}
.sso:hover {
  background: rgb(255 255 255 / 12%);
}
.sso-pick {
  position: relative;
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.sso-trigger {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 20%);
  background: rgb(255 255 255 / 6%);
  color: var(--text-1, #e8edf5);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.sso-trigger:hover { background: rgb(255 255 255 / 12%); }
.sso-trigger-label { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sso-caret { flex: none; opacity: 0.7; transition: transform 0.15s ease; }
.sso-caret.up { transform: rotate(180deg); }

/* Anchored to the picker, drawn in this page's palette rather than the OS's. */
.sso-menu {
  position: absolute;
  left: 0;
  right: 52px;
  top: calc(100% + 6px);
  z-index: 20;
  margin: 0;
  padding: 4px;
  list-style: none;
  border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 18%);
  background: #161b24;
  box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
  /* A deployment fronting several directories can list more than fits the
     card, and the stage clips — without these the lower rows are unreachable. */
  max-height: 232px;
  overflow-y: auto;
}
.sso-menu li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 6px;
  color: var(--text-1, #e8edf5);
  font-size: 13px;
  cursor: pointer;
}
.sso-menu li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sso-menu li.active { background: rgb(255 255 255 / 10%); }
.sso-menu li.on { color: #fff; font-weight: 600; }
.sso-tick { margin-left: auto; opacity: 0.75; }

/* The arrow is the commit step: pick on the left, go here. */
.sso-go {
  flex: none;
  width: 44px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 20%);
  background: rgb(255 255 255 / 6%);
  color: var(--text-1, #e8edf5);
  text-decoration: none;
}
.sso-go:hover { background: rgb(255 255 255 / 14%); }
.sso-icon {
  width: 16px;
  height: 16px;
  vertical-align: -3px;
  margin-right: 8px;
}
</style>
