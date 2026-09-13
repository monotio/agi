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
  Discard,
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
import { pickThroughLayers, type StagePick } from "../explodedPick.ts";

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

  /** Enable or disable the CRT pass. */
  set crt(on: boolean) {
    if (this.disposed) return;
    this.crtUniform.value = on ? 1 : 0;
    this.quad.material = on ? this.crtMaterial : this.flatMaterial;
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
    if (this.disposed) return;
    const rawDpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const dpr = Math.min(Math.max(1, rawDpr), 2);
    const width = Math.max(1, Math.round((canvas.clientWidth || FRAME_WIDTH * 2) * dpr));
    const height = Math.max(1, Math.round((canvas.clientHeight || FRAME_HEIGHT * 2) * dpr));
    this.renderer.setSize(width, height, false);
    this.scanPeriod.value = Math.max(1, Math.round(height / FRAME_HEIGHT));
    // Resizing clears the canvas even while a remix has paused new frames.
    if (this.scene.children.length) this.renderPass();
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
    if (this.pendingRaf !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.pendingRaf);
      this.pendingRaf = null;
    }
    this.observer?.disconnect();
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
    try {
      this.renderer.dispose();
    } catch {
      // safe teardown
    }
  }
}
