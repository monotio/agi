/**
 * three.js presentation stage: the composed 320x200 frame (picture band +
 * text cells, see composite.ts) as a nearest-neighbour DataTexture on ONE
 * fullscreen quad, shaded by ONE TSL node graph that serves both backends —
 * WebGPU when available, WebGL 2 through `forceWebGL` otherwise. Null when
 * neither initialises (the caller keeps the plain 2D canvas visible).
 *
 * The CRT pass lives in that node graph so it affects text exactly like
 * graphics. It models the tube in linear light: each scanline is a beam
 * reconstructed from its neighbouring pixels (the analogue signal's soft
 * edges), drawn as a Gaussian whose width grows with brightness so bright
 * areas bloom together and dark ones show their lines; a slot mask of RGB
 * phosphors on device pixels; halation scattered in the glass (crtGlow.ts);
 * and gently curved glass with antialiased rounded corners. Play uses it;
 * editing always shows the crisp frame through the flat material.
 *
 * The canvas renders at its real device-pixel size. The phosphor mask uses
 * integer device-pixel periods in screen space, so neither the warp nor CSS
 * scaling can beat against it into moiré, and beams merge into a flat field
 * when a scanline gets too few device pixels to resolve.
 */
import { watch } from "vue";
import { layoutDragging } from "../play/layoutDrag.ts";
import * as THREE from "three";
import { MeshBasicNodeMaterial, WebGPURenderer, type Node } from "three/webgpu";
import {
  Discard,
  Fn,
  abs,
  clamp,
  dot,
  exp,
  float,
  floor,
  length,
  max,
  min,
  mix,
  mod,
  screenCoordinate,
  select,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { FRAME_HEIGHT, FRAME_WIDTH } from "../render/composite.ts";
import { CRT_GLASS, CRT_STAGES } from "./crtAmount.ts";
import { CRT_GLOW_HEIGHT, CRT_GLOW_WIDTH, crtGlow } from "./crtGlow.ts";
import { pickThroughLayers, type StagePick } from "../inspector/explodedPick.ts";

/** Logical picture geometry the exploded view separates into depth layers. */
const PIC_W = 160;
const PIC_H = 168;
/** Picture band as a fraction of the 320x200 frame, measured from the top. */
const PIC_FRAC = PIC_H / FRAME_HEIGHT;
/** Z spacing between priority layers in the exploded scene. */
const LAYER_GAP = 0.045;
/** Exploded-view camera distance; every layer's scale derives from it. */
const CAMERA_Z = 2.7;
/** Camera height in the exploded view. */
const CAM_Y = 0.42;
/**
 * How much of each layer's depth survives as scale: 0 fully compensates
 * (every layer projects to the identical frame footprint — flat-looking at
 * rest), 1 leaves raw perspective. A partial value lets nearer layers read
 * as slightly larger and radially expanded around the frame centre — the
 * exploded look — while content stays registered over its logical spot.
 */
const LAYER_SPREAD = 0.4;
export type { StagePick };

/** The CRT tube's character. Sigmas are in frame pixels. */
const CRT = {
  ...CRT_GLASS,
  /** Signal softness along a scanline. */
  signalSigma: 0.39,
  /** Beam height for black and for full white. */
  darkSigma: 0.27,
  brightSigma: 0.41,
  /** Beam height once lines are too small to resolve. */
  mergedSigma: 0.61,
  /** Phosphor mask depth on high-density and on standard screens. */
  maskStrength: 0.3,
  maskStrengthLow: 0.12,
  /** Darkening of the gap row between slots. */
  slotGap: 0.12,
  /** Glass scatter of all light, and extra glow above the threshold. */
  halation: 0.06,
  glowThreshold: 0.35,
  glow: 0.26,
  /** Edge darkening at the corners. */
  vignette: 0.06,
};

/**
 * Keyboard attention: while the game has the keyboard, a light traces the
 * inside of the glass; in Play the picture dims like a monitor in standby
 * when the keyboard is elsewhere. Lengths are CSS pixels.
 */
const ATTENTION = {
  /** The accent colour (--action, #79e5e6) in linear light. */
  rim: [0.191, 0.784, 0.791] as const,
  /** A crisp line on the edge, and a soft glow falling off inside it. */
  line: 1.5,
  lineStrength: 0.55,
  glow: 7,
  glowStrength: 0.45,
  standby: 0.72,
  /** Fade time in milliseconds. */
  fade: 160,
};

/** Control-line colours (priority 0-3) on the rearmost exploded layer. */
const CONTROL_TINTS: [number, number, number][] = [
  [1.0, 0.25, 0.25],
  [1.0, 0.69, 0.12],
  [0.25, 0.88, 0.38],
  [0.25, 0.63, 1.0],
];

export class AgiStage {
  private readonly renderer: WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly texture: THREE.DataTexture;
  private readonly rgba = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  private frameUploaded = false;
  private readonly glowRgba = new Uint8Array(CRT_GLOW_WIDTH * CRT_GLOW_HEIGHT * 4);
  private readonly glowTexture: THREE.DataTexture;
  private readonly amount = uniform(1).setName("crtAmount");
  /** Canvas size in device pixels. */
  private readonly outSize = uniform(new THREE.Vector2(FRAME_WIDTH * 2, FRAME_HEIGHT * 2));
  /** Device pixels per CSS pixel, capped at 2. */
  private readonly dpr = uniform(1);
  /** 1 while the game has the keyboard, faded in and out. */
  private readonly focusLevel = uniform(0);
  /** Picture brightness: 1 awake, lower in standby. */
  private readonly wakeLevel = uniform(1);
  private attention = { focus: 0, wake: 1 };
  private attentionRaf: number | null = null;
  private readonly isWebGpu: boolean;
  private readonly observer: ResizeObserver | null;
  private readonly quad: THREE.Mesh;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly crtMaterial: MeshBasicNodeMaterial;
  private readonly flatMaterial: MeshBasicNodeMaterial;
  private pendingRaf: number | null = null;
  private disposed = false;
  /**
   * Exploded priority-layer scene: one plane per depth band, masked to that
   * band's pixels, separated in Z and viewed under a perspective camera with
   * pointer parallax. Built lazily on first use.
   */
  private exploded = false;
  private explodedGroup: THREE.Group | null = null;
  private explodedGeometry: THREE.PlaneGeometry | null = null;
  private explodedMaterials: MeshBasicNodeMaterial[] = [];
  private prioTexture: THREE.DataTexture | null = null;
  private picTexture: THREE.DataTexture | null = null;
  private picPriTexture: THREE.DataTexture | null = null;
  private ownerTexture: THREE.DataTexture | null = null;
  private previewTexture: THREE.DataTexture | null = null;
  private textTexture: THREE.DataTexture | null = null;
  private explodedLayers: { mesh: THREE.Mesh; z: number; s: number; fullFrame: boolean }[] = [];
  /** World-space y of the picture band's centre at z=0; set from picRow. */
  private bandCenterY = 0.08;
  private perspCamera: THREE.PerspectiveCamera | null = null;
  private picRowUniform = uniform(8);
  private pointerTarget = { x: 0, y: 0 };
  private pointerNow = { x: 0, y: 0 };
  private readonly raycaster = new THREE.Raycaster();
  private readonly vec3Tmp = new THREE.Vector3();
  private readonly vec2Tmp = new THREE.Vector2();
  private parallaxRaf: number | null = null;

  private readonly stopLayoutWatch: () => void;

  private constructor(renderer: WebGPURenderer, isWebGpu: boolean, canvas: HTMLCanvasElement) {
    this.renderer = renderer;
    this.isWebGpu = isWebGpu;
    this.fit(canvas);
    this.observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.fit(canvas));
    this.observer?.observe(canvas);
    this.stopLayoutWatch = watch(
      layoutDragging,
      (dragging) => {
        if (!dragging) this.fit(canvas);
      },
      { flush: "post" },
    );
    this.texture = new THREE.DataTexture(this.rgba, FRAME_WIDTH, FRAME_HEIGHT);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Allocate the frame texture before the first render binds its sampler.
    // Otherwise WebGPU can retain the black placeholder until a later draw.
    this.texture.needsUpdate = true;

    this.glowTexture = new THREE.DataTexture(this.glowRgba, CRT_GLOW_WIDTH, CRT_GLOW_HEIGHT);
    this.glowTexture.magFilter = THREE.LinearFilter;
    this.glowTexture.minFilter = THREE.LinearFilter;
    this.glowTexture.needsUpdate = true;

    const frame = this.texture;
    const glow = this.glowTexture;
    const outSize = this.outSize;
    const dpr = this.dpr;

    this.geometry = new THREE.PlaneGeometry(2, 2);

    const focusLevel = this.focusLevel;
    const wakeLevel = this.wakeLevel;
    /** Distance in device pixels outside a rounded rectangle (negative inside). */
    const edgeDistance = (point: Node<"vec2">, cornerRadius: number | Node<"float">) => {
      const px = point.mul(outSize);
      const half = outSize.mul(0.5);
      const radius = min(outSize.x, outSize.y).mul(cornerRadius);
      const corner = abs(px.sub(half)).sub(half).add(radius);
      return length(max(corner, 0.0))
        .add(min(max(corner.x, corner.y), 0.0))
        .sub(radius);
    };
    /** The keyboard light along the inside of an edge; `spread` scales its glow. */
    const rimLight = (distance: Node<"float">, spread: Node<"float">) => {
      const inside = max(distance.negate(), 0.0).div(dpr);
      const line = float(1.0)
        .sub(smoothstep(0.0, ATTENTION.line, inside))
        .mul(ATTENTION.lineStrength);
      const glow = exp(inside.div(spread.mul(-ATTENTION.glow))).mul(
        spread.mul(ATTENTION.glowStrength),
      );
      return vec3(...ATTENTION.rim)
        .mul(line.add(glow))
        .mul(focusLevel);
    };

    // Editing and CRT-off: one direct texture fetch, the crisp frame.
    this.flatMaterial = new MeshBasicNodeMaterial();
    this.flatMaterial.colorNode = Fn(() => {
      const p = uv();
      const sampleUv = vec2(p.x, float(1.0).sub(p.y));
      const picture = texture(frame, sampleUv).rgb.mul(wakeLevel);
      // The crisp frame has no border, so its glow stays close to the edge.
      return picture.add(rimLight(edgeDistance(p, 0.0), float(0.5)));
    })();

    const crtAmount = this.amount;
    this.crtMaterial = new MeshBasicNodeMaterial();
    this.crtMaterial.colorNode = Fn(() => {
      const phosphorAmount = smoothstep(...CRT_STAGES.phosphor, crtAmount);
      const lightAmount = smoothstep(...CRT_STAGES.light, crtAmount);
      const glassAmount = smoothstep(...CRT_STAGES.glass, crtAmount);
      const overscan = glassAmount.mul(CRT.overscan);
      // Curved glass: each axis bows with the other's distance from the
      // centre, as a tube's face does. Quad UV has its origin bottom-left.
      const c = uv().sub(0.5).mul(2.0);
      const warped = vec2(
        c.x.mul(float(1.0).add(c.y.mul(c.y).mul(glassAmount.mul(CRT.curveX)))),
        c.y.mul(float(1.0).add(c.x.mul(c.x).mul(glassAmount.mul(CRT.curveY)))),
      ).mul(overscan.add(1));
      const q = warped.mul(0.5).add(0.5);

      // Rounded-rectangle edge of the visible tube face, antialiased over
      // one device pixel.
      const edge = edgeDistance(q, glassAmount.mul(CRT.cornerRadius));
      const face = clamp(float(0.5).sub(edge), 0.0, 1.0);

      // Keep the complete rectangular frame inside the rounded glass. The
      // overscan belongs to this black border, including the bowed corners.
      const frameUv = q.sub(0.5).mul(overscan.mul(2).add(1)).add(0.5);
      const frameFace = clamp(float(0.5).sub(edgeDistance(frameUv, 0.0)), 0.0, 1.0);
      // Source position in frame pixels, rows counted from the top.
      const sx = frameUv.x.mul(FRAME_WIDTH);
      const sy = float(1.0).sub(frameUv.y).mul(FRAME_HEIGHT);
      const baseX = floor(sx.sub(0.5));
      const baseY = floor(sy.sub(0.5));

      // A scanline needs a few device pixels to show its beam profile;
      // below that the beams widen until they merge into a flat field.
      const linePixels = outSize.y.div(FRAME_HEIGHT);
      const resolved = smoothstep(2.5, 4.5, linePixels);

      const lines = [-1, 0, 1, 2].map((row) => {
        const line = baseY.add(row);
        const v = line.add(0.5).div(FRAME_HEIGHT);
        // The beam along this line: neighbouring pixels blended by a
        // Gaussian, as the signal's limited bandwidth softened every edge.
        const taps = [-1, 0, 1, 2].map((tap) => {
          const column = baseX.add(tap);
          const dx = column.add(0.5).sub(sx);
          const weight = exp(dx.mul(dx).mul(-0.5 / (CRT.signalSigma * CRT.signalSigma)));
          const pixel = texture(frame, vec2(column.add(0.5).div(FRAME_WIDTH), v)).rgb;
          return { colour: pixel.mul(weight), weight };
        });
        const signal = taps
          .map((t) => t.colour)
          .reduce((a, b) => a.add(b))
          .div(taps.map((t) => t.weight).reduce((a, b) => a.add(b)));
        // Brighter beams are wider. Each beam keeps its energy, so the
        // picture's average brightness matches the frame.
        const luma = dot(signal, vec3(0.2126, 0.7152, 0.0722));
        const sigma = mix(
          float(CRT.mergedSigma),
          mix(float(CRT.darkSigma), float(CRT.brightSigma), sqrt(luma)),
          resolved.mul(phosphorAmount),
        );
        const dy = line.add(0.5).sub(sy);
        const profile = exp(dy.mul(dy).div(sigma.mul(sigma).mul(-2.0))).div(sigma.mul(2.5066));
        return signal.mul(profile);
      });
      const beams = lines.reduce((a, b) => a.add(b));

      // Slot-mask phosphors on device pixels: R, G, B columns, with every
      // other triad's slots offset by half a slot. Retina screens show the
      // slots; at one device pixel per CSS pixel only a faint grille remains.
      const device = floor(screenCoordinate.xy);
      const sub = mod(device.x, 3.0);
      const triad = floor(device.x.div(3.0));
      const fine = step(1.5, dpr);
      const strength = mix(float(CRT.maskStrengthLow), float(CRT.maskStrength), fine).mul(
        phosphorAmount,
      );
      const lit = float(1.0);
      const dim = float(1.0).sub(strength);
      const phosphor = vec3(
        select(sub.lessThan(1.0), lit, dim),
        select(sub.greaterThanEqual(1.0).and(sub.lessThan(2.0)), lit, dim),
        select(sub.greaterThanEqual(2.0), lit, dim),
      );
      const slotRow = mod(device.y.add(mod(triad, 2.0).mul(2.0)), 4.0);
      const slotGap = step(2.5, slotRow).mul(fine).mul(phosphorAmount).mul(CRT.slotGap);
      const mask = phosphor.mul(float(1.0).sub(slotGap));
      // Lift the average back to the frame's brightness.
      const maskMean = float(1.0)
        .add(dim.mul(2.0))
        .div(3.0)
        .mul(float(1.0).sub(fine.mul(phosphorAmount).mul(CRT.slotGap / 4)));

      // Halation: the glass scatters every phosphor's light a little and
      // the brightest ones more.
      const scattered = texture(glow, vec2(frameUv.x, float(1.0).sub(frameUv.y))).rgb;
      const halation = scattered
        .mul(CRT.halation)
        .add(scattered.sub(CRT.glowThreshold).max(0.0).mul(CRT.glow))
        .mul(lightAmount);

      const vignette = float(1.0).sub(dot(c, c).mul(lightAmount).mul(CRT.vignette));
      const crisp = texture(frame, vec2(frameUv.x, float(1.0).sub(frameUv.y))).rgb;
      const signal = select(
        phosphorAmount.greaterThanEqual(1),
        beams,
        mix(crisp, beams, phosphorAmount),
      );
      const tube = signal.mul(mask).div(maskMean).add(halation).mul(vignette).mul(wakeLevel);
      return tube
        .mul(frameFace)
        .add(rimLight(edge, mix(0.5, 1, glassAmount)))
        .mul(face);
    })();

    this.quad = new THREE.Mesh(this.geometry, this.crtMaterial);
    this.scene.add(this.quad);
  }

  /** GPU flavour actually in use ("webgpu" | "webgl2"), surfaced in the debug UI. */
  get backend(): string {
    return this.isWebGpu ? "webgpu" : "webgl2";
  }

  get explodedMode(): boolean {
    return this.exploded;
  }

  /**
   * Switch between the flat quad and the exploded priority-layer scene.
   * The exploded view needs the priority buffer — upload it with
   * setPriority() whenever a frame posts while exploded.
   */
  setExplodedMode(on: boolean): void {
    if (this.disposed || on === this.exploded) return;
    this.exploded = on;
    if (on) {
      if (!this.explodedGroup) this.buildExplodedScene();
      this.quad.visible = false;
      this.explodedGroup!.visible = true;
      this.startParallax();
    } else {
      this.quad.visible = true;
      if (this.explodedGroup) this.explodedGroup.visible = false;
      this.stopParallax();
    }
    this.renderPass();
  }

  /** Pointer position over the canvas, -1..1 in both axes, for parallax. */
  setPointer(nx: number, ny: number): void {
    this.pointerTarget.x = Math.min(Math.max(nx, -1), 1);
    this.pointerTarget.y = Math.min(Math.max(ny, -1), 1);
  }

  /**
   * Upload the 160x168 priority buffer the exploded layers mask against, plus
   * the picture-band row so layer textures can address the right frame rows.
   */
  setPriority(priority: Uint8Array | null, picRow: number): void {
    if (this.disposed || !priority) return;
    this.picRowUniform.value = picRow * 8;
    this.layoutExplodedLayers();
    if (!this.prioTexture) return;
    const data = this.prioTexture.image.data as Uint8Array;
    if (data.length !== priority.length) return;
    data.set(priority);
    this.prioTexture.needsUpdate = true;
  }

  /**
   * Upload the text-only composite (alpha 0 where no cell was written) for
   * the exploded view's front plane. Call each frame while exploded.
   */
  setTextLayer(rgba: Uint8Array | Uint8ClampedArray): void {
    if (this.disposed || !this.textTexture) return;
    (this.textTexture.image.data as Uint8Array).set(rgba);
    this.textTexture.needsUpdate = true;
  }

  /**
   * Upload the picture-only composite (no screen objects) and its priority
   * buffer. Band layers sample these, so sprite pixels leave no holes in the
   * wall — the wall behind a sprite stays intact on its own depth layer.
   */
  setPictureData(rgba: Uint8Array | Uint8ClampedArray, priority: Uint8Array): void {
    if (this.disposed || !this.picTexture || !this.picPriTexture) return;
    (this.picTexture.image.data as Uint8Array).set(rgba);
    this.picTexture.needsUpdate = true;
    (this.picPriTexture.image.data as Uint8Array).set(priority);
    this.picPriTexture.needsUpdate = true;
  }

  /**
   * Upload the per-pixel object ownership (num + 1, 0 = background). Sprite
   * layers mask on it so only real object pixels render on a band. Pass null
   * when the ownership channel is disarmed: an absent buffer must not leave
   * a previous frame's ownership describing current pixels.
   */
  setOwnershipData(ownership: Uint16Array | null): void {
    if (this.disposed || !this.ownerTexture) return;
    const data = this.ownerTexture.image.data as Uint8Array;
    if (ownership === null) {
      data.fill(0);
      this.ownerTexture.needsUpdate = true;
      return;
    }
    if (data.length !== ownership.length) return;
    for (let i = 0; i < ownership.length; i++) data[i] = Math.min(ownership[i]!, 255);
    this.ownerTexture.needsUpdate = true;
  }

  /**
   * Upload the show.obj preview mask (1 where the modal cel wrote). Pass null
   * when the modal is closed — a stale mask would keep drawing a preview that
   * the frame no longer contains.
   */
  setPreviewMask(mask: Uint8Array | null): void {
    if (this.disposed || !this.previewTexture) return;
    const data = this.previewTexture.image.data as Uint8Array;
    if (mask === null) {
      data.fill(0);
    } else if (data.length === mask.length) {
      data.set(mask);
    } else {
      return;
    }
    this.previewTexture.needsUpdate = true;
  }

  /** Camera for the current view mode. */
  private activeCamera(): THREE.Camera {
    return this.exploded && this.perspCamera ? this.perspCamera : this.camera;
  }

  private renderPass(): void {
    this.renderer.render(this.scene, this.activeCamera());
  }

  /**
   * Project a logical picture point sitting on a priority band's layer into
   * overlay-canvas pixels (0..320, 0..200). Bands 0-3 share the control layer.
   * Null while flat or when the point falls outside the view.
   */
  projectBandPoint(band: number, lx: number, ly: number): { x: number; y: number } | null {
    if (!this.exploded || !this.perspCamera) return null;
    const h = (PIC_H * 2) / FRAME_HEIGHT;
    const b = Math.min(15, Math.max(3, band));
    const z = (b - 3) * LAYER_GAP;
    // Same math as layoutExplodedLayers: spread scale + ray-centred origin.
    const s = (CAMERA_Z - z * LAYER_SPREAD) / CAMERA_Z;
    const cs = (CAMERA_Z - z) / CAMERA_Z;
    const cy = CAM_Y + (this.bandCenterY - CAM_Y) * cs;
    const v = this.vec3Tmp.set((lx / (PIC_W / 2) - 1) * s, cy + (h / 2 - (ly / PIC_H) * h) * s, z);
    v.project(this.perspCamera);
    if (v.z < -1 || v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * FRAME_WIDTH, y: ((1 - v.y) / 2) * FRAME_HEIGHT };
  }

  /**
   * Reverse of projectBandPoint: cast a ray through normalized device coords
   * (-1..1, y up) into the exploded layers. Intersections are filtered by the
   * same mask rules that render each layer — a geometric hit on a masked-out
   * pixel falls through to the next layer, so the returned pick names the
   * layer and logical point of the pixel the user actually sees.
   */
  pickAt(nx: number, ny: number): StagePick | null {
    if (!this.exploded || !this.perspCamera || !this.explodedGroup) return null;
    this.raycaster.setFromCamera(this.vec2Tmp.set(nx, ny), this.perspCamera);
    const hits = this.raycaster.intersectObjects(this.explodedGroup.children, false);
    return pickThroughLayers(
      hits
        .filter((hit) => hit.uv)
        .map((hit) => ({ name: hit.object.name, u: hit.uv!.x, v: hit.uv!.y })),
      {
        priority: this.prioTexture?.image.data as Uint8Array | undefined,
        picturePriority: this.picPriTexture?.image.data as Uint8Array | undefined,
        owner: this.ownerTexture?.image.data as Uint8Array | undefined,
        preview: this.previewTexture?.image.data as Uint8Array | undefined,
        text: this.textTexture?.image.data as Uint8Array | undefined,
      },
    );
  }

  /**
   * Build the exploded scene. The 2D frame is decomposed into true sources —
   * the picture surface, sprite pixels (by ownership), and the text surface —
   * then each is projected onto its own depth layer: a tinted control layer
   * (priority 0-3), one picture layer per band 4-15, one sprite layer per
   * band, and a front text layer. Every 2D pixel survives on exactly one
   * layer; the depth hierarchy shows as spacing, not missing content.
   */
  private buildExplodedScene(): void {
    const makeMaskTex = () => {
      const t = new THREE.DataTexture(
        new Uint8Array(PIC_W * PIC_H),
        PIC_W,
        PIC_H,
        THREE.RedFormat,
        THREE.UnsignedByteType,
      );
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    this.prioTexture = makeMaskTex();
    this.picPriTexture = makeMaskTex();
    this.ownerTexture = makeMaskTex();
    this.previewTexture = makeMaskTex();
    this.picTexture = new THREE.DataTexture(
      new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4),
      FRAME_WIDTH,
      FRAME_HEIGHT,
    );
    this.picTexture.magFilter = THREE.NearestFilter;
    this.picTexture.minFilter = THREE.NearestFilter;
    this.picTexture.needsUpdate = true;

    this.perspCamera = new THREE.PerspectiveCamera(38, FRAME_WIDTH / FRAME_HEIGHT, 0.1, 20);
    this.perspCamera.position.set(0, CAM_Y, CAMERA_Z);
    this.perspCamera.lookAt(0, -0.02, 0.3);

    const group = new THREE.Group();
    // Band layers get a partially-compensated scale: near layers read as
    // closer by expanding radially around their logical centre, so a sprite
    // stays over whatever it stood in front of. Full-frame layers (text)
    // keep exact compensation so nothing leaves the frame.
    const addLayer = (mesh: THREE.Mesh, z: number, fullFrame: boolean) => {
      const s = fullFrame ? (CAMERA_Z - z) / CAMERA_Z : (CAMERA_Z - z * LAYER_SPREAD) / CAMERA_Z;
      mesh.scale.set(s, s, 1);
      mesh.position.z = z;
      this.explodedLayers.push({ mesh, z, s, fullFrame });
      group.add(mesh);
    };
    const frameTex = this.texture;
    const picTex = this.picTexture;
    const prioTex = this.prioTexture;
    const picPriTex = this.picPriTexture;
    const ownerTex = this.ownerTexture;
    const picRowPx = this.picRowUniform;
    // Picture band is 168 of 200 frame rows → 1.68 in the group's 2-tall space.
    this.explodedGeometry = new THREE.PlaneGeometry(2, PIC_FRAC * 2);
    this.explodedMaterials = [];

    // Mask textures are top-down 160x168 buffers; the band quad's v axis
    // maps 1→0 top to bottom, so sample row = (1 - p.y).
    const maskUv = () => vec2(uv().x, float(1.0).sub(uv().y));
    const samplePri = () => texture(prioTex, maskUv()).x.mul(255.0);
    const samplePicPri = () => texture(picPriTex, maskUv()).x.mul(255.0);
    const sampleOwner = () => texture(ownerTex, maskUv()).x.mul(255.0);
    // Frame/picture textures v: buffer rows are top-down; the band spans rows
    // picRow*8 .. picRow*8+168.
    const frameSample = (t: THREE.DataTexture) =>
      texture(
        t,
        vec2(uv().x, picRowPx.div(FRAME_HEIGHT).add(float(1.0).sub(uv().y).mul(PIC_FRAC))),
      );

    const controlMat = new MeshBasicNodeMaterial();
    controlMat.colorNode = Fn(() => {
      const pri = samplePicPri();
      Discard(pri.greaterThanEqual(3.5));
      const i = pri.floor();
      return select(
        i.lessThan(0.5),
        vec3(...CONTROL_TINTS[0]!),
        select(
          i.lessThan(1.5),
          vec3(...CONTROL_TINTS[1]!),
          select(i.lessThan(2.5), vec3(...CONTROL_TINTS[2]!), vec3(...CONTROL_TINTS[3]!)),
        ),
      );
    })();
    this.explodedMaterials.push(controlMat);
    const controlMesh = new THREE.Mesh(this.explodedGeometry, controlMat);
    controlMesh.name = "control";
    addLayer(controlMesh, -LAYER_GAP * 0.6, false);

    for (let band = 4; band <= 15; band++) {
      const bandU = uniform(band);
      const z = (band - 3) * LAYER_GAP;
      // Wall layer: picture pixels whose picture priority is this band.
      const mat = new MeshBasicNodeMaterial();
      mat.colorNode = Fn(() => {
        const pri = samplePicPri();
        Discard(pri.sub(bandU).abs().greaterThanEqual(0.5));
        return frameSample(picTex);
      })();
      this.explodedMaterials.push(mat);
      const wallMesh = new THREE.Mesh(this.explodedGeometry, mat);
      wallMesh.name = `pic:${band}`;
      addLayer(wallMesh, z, false);
      // Sprite layer: object-owned pixels whose effective priority is this
      // band. A hair in front of the wall so coplanar pixels pick the sprite.
      const spriteMat = new MeshBasicNodeMaterial();
      spriteMat.colorNode = Fn(() => {
        const pri = samplePri();
        const owner = sampleOwner();
        Discard(pri.sub(bandU).abs().greaterThanEqual(0.5).or(owner.lessThan(0.5)));
        return frameSample(frameTex);
      })();
      this.explodedMaterials.push(spriteMat);
      const spriteMesh = new THREE.Mesh(this.explodedGeometry, spriteMat);
      spriteMesh.name = `sprite:${band}`;
      addLayer(spriteMesh, z + 0.004, false);
    }

    // Modal preview layer: the show.obj cel rides band 15 in the composed
    // frame but owns no pixels — without this layer it would be masked out of
    // every sprite band. It floats just behind the text surface so the modal
    // occludes the scene exactly like the flat view.
    const previewTex = this.previewTexture;
    const previewMat = new MeshBasicNodeMaterial();
    previewMat.colorNode = Fn(() => {
      Discard(texture(previewTex, maskUv()).x.lessThan(0.5 / 255));
      return frameSample(frameTex);
    })();
    this.explodedMaterials.push(previewMat);
    const previewMesh = new THREE.Mesh(this.explodedGeometry, previewMat);
    previewMesh.name = "preview";
    addLayer(previewMesh, 12 * LAYER_GAP + 0.2, false);

    // Text plane: samples a text-only composite (transparent where no cell
    // was written) so dialogs and the status line float in front at full
    // size instead of smearing across whichever depth band owns their rows.
    this.textTexture = new THREE.DataTexture(
      new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4),
      FRAME_WIDTH,
      FRAME_HEIGHT,
    );
    this.textTexture.magFilter = THREE.NearestFilter;
    this.textTexture.minFilter = THREE.NearestFilter;
    this.textTexture.needsUpdate = true;
    const textTex = this.textTexture;
    const textMat = new MeshBasicNodeMaterial();
    textMat.colorNode = Fn(() => {
      const p = uv();
      const s = texture(textTex, vec2(p.x, float(1.0).sub(p.y)));
      Discard(s.a.lessThan(0.5));
      return s.rgb;
    })();
    this.explodedMaterials.push(textMat);
    // The text surface is the frontmost layer — full frame, no fan offset,
    // pinned to the footprint so the input row and status line stay put.
    addLayer(new THREE.Mesh(this.geometry, textMat), 12 * LAYER_GAP + 0.35, true);
    this.explodedLayers[this.explodedLayers.length - 1]!.mesh.name = "explodedText";

    this.scene.add(group);
    this.explodedGroup = group;
    this.layoutExplodedLayers();
  }

  /**
   * Centre every layer's origin on the camera ray for the frame region it
   * covers: band layers wrap the picture band, the text layer the whole
   * frame. Depth reads through the scale spread and pointer parallax — never
   * through vertical drift, which would unregister sprites from the scene.
   */
  private layoutExplodedLayers(): void {
    const bandCenter = 1 - (2 * (this.picRowUniform.value + PIC_H / 2)) / FRAME_HEIGHT;
    this.bandCenterY = bandCenter;
    for (const l of this.explodedLayers) {
      const center = l.fullFrame ? 0 : bandCenter;
      const cs = (CAMERA_Z - l.z) / CAMERA_Z;
      l.mesh.position.y = CAM_Y + (center - CAM_Y) * cs;
    }
  }

  /**
   * Show whether the game has the keyboard: `focused` lights the glass edge,
   * `standby` dims the picture. Both fade unless reduced motion is preferred.
   */
  setAttention(focused: boolean, standby: boolean): void {
    if (this.disposed) return;
    const target = { focus: focused ? 1 : 0, wake: standby ? ATTENTION.standby : 1 };
    const instant =
      typeof requestAnimationFrame === "undefined" ||
      (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (this.attentionRaf !== null) cancelAnimationFrame(this.attentionRaf);
    this.attentionRaf = null;
    const from = { ...this.attention };
    const start = performance.now();
    const step = (now: number) => {
      const t = instant ? 1 : Math.min(1, (now - start) / ATTENTION.fade);
      const eased = 1 - (1 - t) ** 3;
      this.attention = {
        focus: from.focus + (target.focus - from.focus) * eased,
        wake: from.wake + (target.wake - from.wake) * eased,
      };
      this.focusLevel.value = this.attention.focus;
      this.wakeLevel.value = this.attention.wake;
      this.renderPass();
      this.attentionRaf = t < 1 && !this.disposed ? requestAnimationFrame(step) : null;
    };
    step(start);
  }

  /** The material reads this single amount uniform; Off uses the flat pass. */
  get crtAmount(): number {
    return this.amount.value;
  }

  set crtAmount(amount: number) {
    if (this.disposed) return;
    this.amount.value = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
    this.quad.material = this.amount.value > 0 ? this.crtMaterial : this.flatMaterial;
    if (this.amount.value > CRT_STAGES.light[0]) this.updateGlow();
    // Static rooms and paused games may not emit another frame. Apply the
    // display setting immediately using the texture already on the GPU.
    this.renderPass();
  }

  private readonly parallaxTick = (): void => {
    this.parallaxRaf = null;
    if (this.disposed || !this.exploded || !this.perspCamera) return;
    this.pointerNow.x += (this.pointerTarget.x - this.pointerNow.x) * 0.08;
    this.pointerNow.y += (this.pointerTarget.y - this.pointerNow.y) * 0.08;
    this.perspCamera.position.set(
      this.pointerNow.x * 0.18,
      0.42 - this.pointerNow.y * 0.1,
      CAMERA_Z,
    );
    this.perspCamera.lookAt(0, -0.02, 0.3);
    this.renderPass();
    if (typeof requestAnimationFrame !== "undefined")
      this.parallaxRaf = requestAnimationFrame(this.parallaxTick);
  };

  private startParallax(): void {
    if (this.parallaxRaf === null && typeof requestAnimationFrame !== "undefined")
      this.parallaxRaf = requestAnimationFrame(this.parallaxTick);
  }

  private stopParallax(): void {
    if (this.parallaxRaf !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.parallaxRaf);
      this.parallaxRaf = null;
    }
  }

  /** Match the backing store to the displayed size in device pixels with a max DPR cap. */
  private fit(canvas: HTMLCanvasElement): void {
    if (this.disposed || layoutDragging.value) return;
    const rawDpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const dpr = Math.min(Math.max(1, rawDpr), 2);
    const width = Math.max(1, Math.round((canvas.clientWidth || FRAME_WIDTH * 2) * dpr));
    const height = Math.max(1, Math.round((canvas.clientHeight || FRAME_HEIGHT * 2) * dpr));
    if (this.outSize.value.x === width && this.outSize.value.y === height && this.dpr.value === dpr)
      return;
    this.renderer.setSize(width, height, false);
    this.outSize.value.set(width, height);
    this.dpr.value = dpr;
    // Resizing clears the canvas even while a remix has paused new frames.
    if (this.scene.children.length) this.renderPass();
  }

  static async create(
    canvas: HTMLCanvasElement,
    context?: WebGL2RenderingContext,
  ): Promise<AgiStage | null> {
    const attempts: { forceWebGL: boolean }[] = context
      ? [{ forceWebGL: true }]
      : [{ forceWebGL: false }, { forceWebGL: true }];
    for (const { forceWebGL } of attempts) {
      let renderer: WebGPURenderer | null = null;
      try {
        renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL, context });
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
    // A stationary game still posts cycle frames. Its flat view can keep the
    // texture already presented; exploded masks may change independently.
    if (this.frameUploaded && !this.exploded && frame.length === this.rgba.length) {
      let changed = false;
      for (let i = 0; i < frame.length; i++) {
        if (frame[i] !== this.rgba[i]) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        if (immediate && this.pendingRaf !== null) this.flush();
        return;
      }
    }
    this.rgba.set(frame);
    this.frameUploaded = true;
    this.texture.needsUpdate = true;
    if (this.amount.value > CRT_STAGES.light[0]) this.updateGlow();
    if (immediate || typeof requestAnimationFrame === "undefined") {
      if (this.pendingRaf !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this.pendingRaf);
        this.pendingRaf = null;
      }
      this.renderPass();
      return;
    }
    if (this.pendingRaf === null) {
      this.pendingRaf = requestAnimationFrame(() => {
        this.pendingRaf = null;
        if (!this.disposed) {
          this.renderPass();
        }
      });
    }
  }

  private updateGlow(): void {
    crtGlow(this.rgba, this.glowRgba);
    this.glowTexture.needsUpdate = true;
  }

  flush(): void {
    if (this.disposed) return;
    if (this.pendingRaf !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.pendingRaf);
      this.pendingRaf = null;
    }
    this.renderPass();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopParallax();
    if (this.attentionRaf !== null) cancelAnimationFrame(this.attentionRaf);
    if (this.pendingRaf !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.pendingRaf);
      this.pendingRaf = null;
    }
    this.observer?.disconnect();
    this.stopLayoutWatch();
    this.scene.remove(this.quad);
    if (this.explodedGroup) this.scene.remove(this.explodedGroup);
    this.explodedGeometry?.dispose();
    for (const mat of this.explodedMaterials) mat.dispose();
    this.prioTexture?.dispose();
    this.picTexture?.dispose();
    this.picPriTexture?.dispose();
    this.ownerTexture?.dispose();
    this.textTexture?.dispose();
    this.geometry.dispose();
    this.flatMaterial.dispose();
    this.crtMaterial.dispose();
    this.texture.dispose();
    this.glowTexture.dispose();
    try {
      this.renderer.dispose();
    } catch {
      // safe teardown
    }
  }
}
