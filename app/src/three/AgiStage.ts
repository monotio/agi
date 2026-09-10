/**
 * three.js presentation stage: the composed 320x200 frame (picture band +
 * text cells, see composite.ts) as a nearest-neighbour DataTexture on ONE
 * fullscreen quad, shaded by ONE TSL node graph that serves both backends —
 * WebGPU when available, WebGL 2 through `forceWebGL` otherwise. Null when
 * neither initialises (the caller keeps the plain 2D canvas visible).
 *
 * The CRT pass lives in that node graph so it affects text exactly like
 * graphics: curved glass, scanline bands, phosphor triads and highlight glow.
 * `crt` toggles it at runtime without rebuilding the material.
 *
 * The canvas renders at its real device-pixel size and the scanline/triad
 * masks are computed in screen space with integer periods, so neither the
 * warp nor CSS scaling can beat against them into moiré.
 */
import * as THREE from "three";
import { MeshBasicNodeMaterial, WebGPURenderer } from "three/webgpu";
import {
  Fn,
  float,
  mix,
  mod,
  screenCoordinate,
  select,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { FRAME_HEIGHT, FRAME_WIDTH } from "../composite.ts";

export class AgiStage {
  private readonly renderer: WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly texture: THREE.DataTexture;
  private readonly rgba = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  private readonly crtUniform = uniform(1);
  /** Device-pixel rows per frame row (>= 2 enables scanlines). */
  private readonly scanPeriod = uniform(2);
  private readonly isWebGpu: boolean;
  private readonly observer: ResizeObserver | null;
  private readonly quad: THREE.Mesh;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly crtMaterial: MeshBasicNodeMaterial;
  private readonly flatMaterial: MeshBasicNodeMaterial;
  private pendingRaf: number | null = null;
  private disposed = false;

  private constructor(renderer: WebGPURenderer, isWebGpu: boolean, canvas: HTMLCanvasElement) {
    this.renderer = renderer;
    this.isWebGpu = isWebGpu;
    this.fit(canvas);
    this.observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.fit(canvas));
    this.observer?.observe(canvas);
    this.texture = new THREE.DataTexture(this.rgba, FRAME_WIDTH, FRAME_HEIGHT);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Allocate the frame texture before the first render binds its sampler.
    // Otherwise WebGPU can retain the black placeholder until a later draw.
    this.texture.needsUpdate = true;

    const frame = this.texture;
    const crt = this.crtUniform;
    const scanPeriod = this.scanPeriod;

    this.geometry = new THREE.PlaneGeometry(2, 2);

    // Cheap flat material for CRT-off mode: one direct texture fetch, zero warp/scanlines/triads/halo
    this.flatMaterial = new MeshBasicNodeMaterial();
    this.flatMaterial.colorNode = Fn(() => {
      const p = uv();
      const sampleUv = vec2(p.x, float(1.0).sub(p.y));
      return texture(frame, sampleUv);
    })();

    // Full CRT material with curvature, scanlines, triads, vignette, and halo
    this.crtMaterial = new MeshBasicNodeMaterial();
    this.crtMaterial.colorNode = Fn(() => {
      // Quad UV, origin bottom-left. The frame is stored top-down, so flip v.
      const p = uv();
      // Barrel warp around the centre (strength scaled by the crt toggle).
      const centred = p.sub(0.5).mul(2.0);
      const r2 = centred.dot(centred);
      const warped = centred.mul(float(1.0).add(r2.mul(0.03).mul(crt)));
      const q = warped.mul(0.5).add(0.5);
      const inside = step(0.0, q.x).mul(step(q.x, 1.0)).mul(step(0.0, q.y)).mul(step(q.y, 1.0));
      const sampleUv = vec2(q.x, float(1.0).sub(q.y));
      const color = texture(frame, sampleUv).rgb;

      // Scale the dark band with each scanline, so it remains visible on
      // Retina displays rather than shrinking to one faint device-pixel row.
      const scanPhase = mod(screenCoordinate.y, scanPeriod).div(scanPeriod);
      const scanHit = step(scanPhase, 0.28).mul(step(2.0, scanPeriod));
      const scan = float(1.0).sub(scanHit.mul(0.42));
      // Phosphor triad on device pixels.
      const triad = mod(screenCoordinate.x, 3.0);
      const mask = vec3(
        select(triad.lessThan(1.0), 1.0, 0.8),
        select(triad.greaterThanEqual(1.0).and(triad.lessThan(2.0)), 1.0, 0.8),
        select(triad.greaterThanEqual(2.0), 1.0, 0.8),
      );
      // Vignette.
      const vignette = float(1.0).sub(r2.mul(0.11));
      // A small phosphor halo around bright pixels. Keep the source sample
      // sharp: only neighbouring highlights contribute, never a whole-frame blur.
      const neighbours = texture(frame, sampleUv.add(vec2(1 / FRAME_WIDTH, 0)))
        .rgb.add(texture(frame, sampleUv.sub(vec2(1 / FRAME_WIDTH, 0))).rgb)
        .add(texture(frame, sampleUv.add(vec2(0, 1 / FRAME_HEIGHT))).rgb)
        .add(texture(frame, sampleUv.sub(vec2(0, 1 / FRAME_HEIGHT))).rgb)
        .mul(0.25);
      const halo = neighbours.sub(0.55).max(0).mul(0.24);
      const treated = color.mul(scan).mul(mask).mul(vignette).mul(1.16).add(halo);
      const shaded = mix(color, treated, crt);
      return shaded.mul(inside);
    })();

    this.quad = new THREE.Mesh(this.geometry, this.crtMaterial);
    this.scene.add(this.quad);
  }

  /** GPU flavour actually in use ("webgpu" | "webgl2"), surfaced in the debug UI. */
  get backend(): string {
    return this.isWebGpu ? "webgpu" : "webgl2";
  }

  /** Enable or disable the CRT pass. */
  set crt(on: boolean) {
    if (this.disposed) return;
    this.crtUniform.value = on ? 1 : 0;
    this.quad.material = on ? this.crtMaterial : this.flatMaterial;
    // Static rooms and paused games may not emit another frame. Apply the
    // display setting immediately using the texture already on the GPU.
    this.renderer.render(this.scene, this.camera);
  }

  /** Match the backing store to the displayed size in device pixels with a max DPR cap. */
  private fit(canvas: HTMLCanvasElement): void {
    if (this.disposed) return;
    const rawDpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const dpr = Math.min(Math.max(1, rawDpr), 2);
    const width = Math.max(1, Math.round((canvas.clientWidth || FRAME_WIDTH * 2) * dpr));
    const height = Math.max(1, Math.round((canvas.clientHeight || FRAME_HEIGHT * 2) * dpr));
    this.renderer.setSize(width, height, false);
    this.scanPeriod.value = Math.max(1, Math.round(height / FRAME_HEIGHT));
    // Resizing clears the canvas even while a remix has paused new frames.
    if (this.scene.children.length) this.renderer.render(this.scene, this.camera);
  }

  static async create(canvas: HTMLCanvasElement): Promise<AgiStage | null> {
    const attempts: { forceWebGL: boolean }[] = [{ forceWebGL: false }, { forceWebGL: true }];
    for (const { forceWebGL } of attempts) {
      let renderer: WebGPURenderer | null = null;
      try {
        renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL });
        await renderer.init();
        const gpu =
          !forceWebGL &&
          Boolean((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend);
        return new AgiStage(renderer, gpu, canvas);
      } catch {
        try {
          renderer?.dispose();
        } catch {
          // fall through to next backend
        }
      }
    }
    return null;
  }

  /** Upload a composed 320x200 RGBA frame and draw it. */
  render(frame: Uint8Array | Uint8ClampedArray, immediate = false): void {
    if (this.disposed) return;
    this.rgba.set(frame);
    this.texture.needsUpdate = true;
    if (immediate || typeof requestAnimationFrame === "undefined") {
      if (this.pendingRaf !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this.pendingRaf);
        this.pendingRaf = null;
      }
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.pendingRaf === null) {
      this.pendingRaf = requestAnimationFrame(() => {
        this.pendingRaf = null;
        if (!this.disposed) {
          this.renderer.render(this.scene, this.camera);
        }
      });
    }
  }

  flush(): void {
    if (this.disposed) return;
    if (this.pendingRaf !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.pendingRaf);
      this.pendingRaf = null;
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingRaf !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.pendingRaf);
      this.pendingRaf = null;
    }
    this.observer?.disconnect();
    this.scene.remove(this.quad);
    this.geometry.dispose();
    this.flatMaterial.dispose();
    this.crtMaterial.dispose();
    this.texture.dispose();
    try {
      this.renderer.dispose();
    } catch {
      // safe teardown
    }
  }
}
