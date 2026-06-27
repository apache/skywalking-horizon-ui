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
 * Camera controller for the 3D infra scene.
 *
 * Owns the THREE camera + OrbitControls plumbing. We drive the THREE
 * objects DIRECTLY through template refs, NOT through reactive Vue props:
 * mouse interaction (rotate / zoom / pan) mutates the THREE objects in
 * place, while a Vue prop bound to a static initial value would silently
 * stomp those mutations on every diff. Talking to the instances directly
 * gives the mouse and the toolbar buttons one source of truth. See the
 * feature CLAUDE.md "Scene → OrbitControls plumbing".
 *
 * The Scene wires `cameraRef` / `controlsRef` to `<TresPerspectiveCamera>`
 * / `<OrbitControls>`, applies the initial pose via `:position` /
 * `:target`, and re-exposes the action methods through `defineExpose`.
 * The frame loop reads `getCamera()` / `getControls()` / `camGoal` to
 * glide the side-panel focus.
 */
import { shallowRef, type ShallowRef } from 'vue';
import { PerspectiveCamera, Vector3 } from 'three';

// The only bits of THREE.OrbitControls the camera helpers touch. cientos
// doesn't ship a stable type for the exposed instance, so we narrow to this
// structurally rather than depend on its internals.
export interface OrbitControlsLike {
  update: () => void;
  target: Vector3;
}

// Initial camera heading — azimuth 15° off front, 62° polar from vertical
// (matching OrbitControls' getAzimuthal/getPolarAngle), tuned on the
// showcase to read the stacked tiers. Scale-invariant; the reset AND the
// side-panel focus reuse it so every camera move keeps the same angle.
const CAMERA_AZ = (15 * Math.PI) / 180;
const CAMERA_POL = (62 * Math.PI) / 180;

interface PlacementBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

export interface SceneCamera {
  /** Wired to `<TresPerspectiveCamera ref>`. */
  cameraRef: ShallowRef<PerspectiveCamera | null>;
  /** Wired to `<OrbitControls ref>` — holds cientos's exposed component. */
  controlsRef: ShallowRef<unknown>;
  /** Side-panel focus goal (pos+target), lerped per frame by the Scene's
   *  frame loop; precedes the prop-driven `focusTarget`. */
  camGoal: ShallowRef<{ pos: Vector3; target: Vector3 } | null>;
  initialCameraPos: [number, number, number];
  initialTarget: [number, number, number];
  getCamera: () => PerspectiveCamera | null;
  getControls: () => OrbitControlsLike | null;
  zoom: (factor: number) => void;
  rotateY: (degrees: number) => void;
  pan: (rightAmount: number, upAmount: number) => void;
  resetView: () => void;
  focusOn: (t: { x: number; y: number; z: number }, radius: number) => void;
}

export function useSceneCamera(bounds: PlacementBounds): SceneCamera {
  /** Unit camera→position offset direction for the tuned heading. */
  function headingDir(): Vector3 {
    const s = Math.sin(CAMERA_POL);
    return new Vector3(s * Math.sin(CAMERA_AZ), Math.cos(CAMERA_POL), s * Math.cos(CAMERA_AZ));
  }

  function defaultTargetPos(): [number, number, number] {
    const b = bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const spanXZ = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    // Shift the look-point along the camera's screen-right axis (cos az, 0,
    // -sin az) so the scene sits left-of-centre, clear of the right-hand
    // TIERS panel.
    const shift = spanXZ * 0.1;
    return [
      cx + Math.cos(CAMERA_AZ) * shift,
      b.minY + (b.maxY - b.minY) * 0.4,
      cz - Math.sin(CAMERA_AZ) * shift,
    ];
  }
  function defaultCameraPos(): [number, number, number] {
    const b = bounds;
    const [tx, ty, tz] = defaultTargetPos();
    const spanXZ = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    // Distance scales with the scene footprint so larger / smaller
    // deployments keep the same fill.
    const dist = spanXZ * 0.97 + 6;
    const o = headingDir().multiplyScalar(dist);
    return [tx + o.x, ty + o.y, tz + o.z];
  }

  const initialCameraPos = defaultCameraPos();
  const initialTarget = defaultTargetPos();

  function asOrbitControls(v: unknown): OrbitControlsLike | null {
    if (typeof v !== 'object' || v === null) return null;
    const o = v as { update?: unknown; target?: unknown };
    return typeof o.update === 'function' && o.target ? (v as OrbitControlsLike) : null;
  }
  // `unknown` (not the controls type): the template ref is set to cientos's
  // exposed component object, whose shape we probe at runtime in getControls.
  const controlsRef = shallowRef<unknown>(null);
  function getControls(): OrbitControlsLike | null {
    const r = controlsRef.value;
    if (!r || typeof r !== 'object') return null;
    const inst = (r as { instance?: unknown }).instance;
    if (!inst) return null;
    // Defensive: handle both the auto-unwrapped expose (`inst` IS the
    // controls) AND the older shape where `instance` is still a ref.
    return asOrbitControls(inst) ?? asOrbitControls((inst as { value?: unknown }).value);
  }
  const cameraRef = shallowRef<PerspectiveCamera | null>(null);
  function getCamera(): PerspectiveCamera | null {
    // TresJS may set the ref to the THREE camera directly or to a wrapper
    // whose `.value` holds it — probe both shapes through `unknown`.
    const r = cameraRef.value as unknown;
    if (!r) return null;
    if ((r as { isPerspectiveCamera?: boolean }).isPerspectiveCamera) return r as PerspectiveCamera;
    const inner = (r as { value?: unknown }).value;
    if (inner && (inner as { isPerspectiveCamera?: boolean }).isPerspectiveCamera) {
      return inner as PerspectiveCamera;
    }
    return null;
  }

  // Side-panel focus goal (pos+target), lerped per frame; precedes focusTarget.
  const camGoal = shallowRef<{ pos: Vector3; target: Vector3 } | null>(null);

  /** Zoom by a scalar around the orbit controls' current target. */
  function zoom(factor: number): void {
    const cam = getCamera();
    const c = getControls();
    if (!cam || !c) return;
    const dx = cam.position.x - c.target.x;
    const dy = cam.position.y - c.target.y;
    const dz = cam.position.z - c.target.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) return;
    const newDist = Math.min(240, Math.max(8, dist * factor));
    const k = newDist / dist;
    cam.position.set(c.target.x + dx * k, c.target.y + dy * k, c.target.z + dz * k);
    c.update();
  }

  /** Rotate the camera around the orbit target's Y axis (azimuth). */
  function rotateY(degrees: number): void {
    const cam = getCamera();
    const c = getControls();
    if (!cam || !c) return;
    const angle = (degrees * Math.PI) / 180;
    const dx = cam.position.x - c.target.x;
    const dz = cam.position.z - c.target.z;
    const cs = Math.cos(angle);
    const sn = Math.sin(angle);
    cam.position.x = c.target.x + dx * cs - dz * sn;
    cam.position.z = c.target.z + dx * sn + dz * cs;
    c.update();
  }

  /** Pan along the camera's right (X) and up (Y) screen axes. */
  function pan(rightAmount: number, upAmount: number): void {
    const cam = getCamera();
    const c = getControls();
    if (!cam || !c) return;
    const view = new Vector3().subVectors(c.target, cam.position);
    const dist = view.length();
    if (dist < 1e-3) return;
    view.divideScalar(dist);
    const right = new Vector3().crossVectors(view, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, view).normalize();
    // Step is a fraction of the current view distance so the per-click
    // pan feels consistent across zoom levels.
    const step = dist * 0.12;
    const dxv = right.x * rightAmount * step + up.x * upAmount * step;
    const dyv = right.y * rightAmount * step + up.y * upAmount * step;
    const dzv = right.z * rightAmount * step + up.z * upAmount * step;
    cam.position.x += dxv;
    cam.position.y += dyv;
    cam.position.z += dzv;
    c.target.x += dxv;
    c.target.y += dyv;
    c.target.z += dzv;
    c.update();
  }

  /** Reset to the initial framing. */
  function resetView(): void {
    camGoal.value = null; // cancel any in-flight side-panel focus
    const cam = getCamera();
    const c = getControls();
    if (!cam || !c) return;
    const [cx, cy, cz] = defaultCameraPos();
    cam.position.set(cx, cy, cz);
    const [tx, ty, tz] = defaultTargetPos();
    c.target.set(tx, ty, tz);
    c.update();
  }

  /** Glide the camera to face `target` from the tuned heading (same angle
   *  as the default / reset), zoomed to fit `radius`. Side panel — moves,
   *  doesn't pivot in place. */
  function focusOn(t: { x: number; y: number; z: number }, radius: number): void {
    const target = new Vector3(t.x, t.y, t.z);
    const dist = Math.min(220, Math.max(9, radius * 2.6 + 6));
    camGoal.value = { target, pos: target.clone().addScaledVector(headingDir(), dist) };
  }

  return {
    cameraRef,
    controlsRef,
    camGoal,
    initialCameraPos,
    initialTarget,
    getCamera,
    getControls,
    zoom,
    rotateY,
    pan,
    resetView,
    focusOn,
  };
}
