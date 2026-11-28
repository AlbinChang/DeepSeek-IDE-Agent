/**
 * scene3d/v1 运行时：把声明式场景 JSON 渲染成可交互/可截图的 three.js 画面。
 *
 * 这是 3D 能力的唯一渲染实现，两个消费者共用：
 * - IDE 客户端：Model3DPreview 直接 import 本模块（Vite 打包）；
 * - 服务端预渲染：electron/scripts/build-scene-runtime.mjs 用 esbuild 打成 IIFE，
 *   由 Playwright 载入后截图 PNG，供 Agent 自检。
 *
 * 约束：不依赖 React；所有外部资源都通过 options.resolveUrl 注入，
 * 让客户端走 IPC、无头端走临时 HTTP，渲染逻辑本身保持与宿主环境无关。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const SCENE3D_SCHEMA = 'scene3d/v1';

export type Vec3 = [number, number, number];

export interface Scene3dMaterial {
    color?: string;
    metalness?: number;
    roughness?: number;
    emissive?: string;
    emissiveIntensity?: number;
    opacity?: number;
    transparent?: boolean;
    wireframe?: boolean;
    flatShading?: boolean;
    side?: 'front' | 'back' | 'double';
    map?: string;
}

export interface Scene3dObject {
    type: 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'torusKnot' | 'plane' | 'ring' | 'capsule' | 'model' | 'group';
    name?: string;
    position?: Vec3;
    /** 角度制，避免模型在弧度上反复算错 */
    rotation?: Vec3;
    scale?: Vec3 | number;
    material?: Scene3dMaterial;
    castShadow?: boolean;
    receiveShadow?: boolean;
    size?: Vec3 | number;
    radius?: number;
    radiusTop?: number;
    radiusBottom?: number;
    height?: number;
    width?: number;
    innerRadius?: number;
    outerRadius?: number;
    tube?: number;
    length?: number;
    arc?: number;
    p?: number;
    q?: number;
    widthSegments?: number;
    heightSegments?: number;
    radialSegments?: number;
    tubularSegments?: number;
    thetaSegments?: number;
    capSegments?: number;
    openEnded?: boolean;
    src?: string;
    children?: Scene3dObject[];
}

export interface Scene3dLight {
    type: 'ambient' | 'directional' | 'point' | 'spot';
    color?: string;
    intensity?: number;
    position?: Vec3;
    target?: Vec3;
    castShadow?: boolean;
    distance?: number;
    /** 角度制 */
    angle?: number;
    penumbra?: number;
}

export interface Scene3dSpec {
    schema?: string;
    name?: string;
    description?: string;
    background?: string;
    camera?: {
        position?: Vec3;
        target?: Vec3;
        fov?: number;
        near?: number;
        far?: number;
        autoFrame?: boolean;
    };
    render?: {
        shadows?: boolean;
        grid?: boolean;
        axes?: boolean;
        environment?: 'studio' | 'none';
        exposure?: number;
        antialias?: boolean;
    };
    lights?: Scene3dLight[];
    objects: Scene3dObject[];
}

export interface Scene3dBounds {
    min: Vec3;
    max: Vec3;
    size: Vec3;
    center: Vec3;
    radius: number;
}

export interface Scene3dStats {
    objects: number;
    meshes: number;
    triangles: number;
    drawCalls: number;
    textures: number;
    geometries: number;
    animations: number;
    bounds: Scene3dBounds;
    durationMs: number;
}

export interface Scene3dPixelStats {
    coverage: number;
    meanLuma: number;
    minLuma: number;
    maxLuma: number;
    background: [number, number, number, number];
}

export interface Scene3dPreviewOptions {
    /** 相对资源（模型/贴图）→ 可加载 URL；缺省按原样使用 */
    resolveUrl?: (src: string) => string | Promise<string>;
    /** 默认 true；false 时只渲染一帧（无头截图） */
    interactive?: boolean;
    width?: number;
    height?: number;
    /** 设备像素比上限，默认交互 2 / 无头 1 */
    maxPixelRatio?: number;
    /** 供 Agent 自检的像素统计（需读回帧缓冲） */
    pixelStats?: boolean;
}

export interface Scene3dPreviewHandle {
    resize(width?: number, height?: number): void;
    renderOnce(): void;
    resetView(): void;
    setWireframe(enabled: boolean): void;
    setGrid(enabled: boolean): void;
    setAutoRotate(enabled: boolean): void;
    snapshot(type?: string): string;
    stats(): Scene3dStats;
    pixelStats(): Scene3dPixelStats | null;
    dispose(): void;
}

const DEFAULT_BACKGROUND = '#0b0d12';
const DEFAULT_FOV = 40;
const MAX_OBJECTS = 400;
const DEG2RAD = Math.PI / 180;

function color(value: string | undefined, fallback: string): THREE.Color {
    if (!value) return new THREE.Color(fallback);
    try {
        return new THREE.Color(value);
    } catch {
        return new THREE.Color(fallback);
    }
}

function num(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback;
}

function vec3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
    if (isVec3(value)) return new THREE.Vector3(value[0], value[1], value[2]);
    return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function isVec3(value: unknown): value is Vec3 {
    return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
}

export function fileFormatOf(src: string): 'glb' | 'gltf' | 'obj' | 'stl' | '' {
    const clean = String(src).split(/[?#]/)[0].toLowerCase();
    if (clean.endsWith('.glb')) return 'glb';
    if (clean.endsWith('.gltf')) return 'gltf';
    if (clean.endsWith('.obj')) return 'obj';
    if (clean.endsWith('.stl')) return 'stl';
    return '';
}

async function materialFrom(
    spec: Scene3dMaterial | undefined,
    textureCache: Map<string, THREE.Texture>,
    resolveUrl: (src: string) => string | Promise<string>,
): Promise<THREE.MeshStandardMaterial> {
    const material = new THREE.MeshStandardMaterial({
        color: color(spec?.color, '#c9d1d9'),
        metalness: num(spec?.metalness, 0.05, 0, 1),
        roughness: num(spec?.roughness, 0.55, 0, 1),
        emissive: color(spec?.emissive, '#000000'),
        emissiveIntensity: num(spec?.emissiveIntensity, 1, 0, 10),
        opacity: num(spec?.opacity, 1, 0, 1),
        transparent: spec?.transparent === true || num(spec?.opacity, 1, 0, 1) < 1,
        wireframe: spec?.wireframe === true,
        flatShading: spec?.flatShading === true,
        side: spec?.side === 'back' ? THREE.BackSide : spec?.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (spec?.map) {
        const key = spec.map;
        const existing = textureCache.get(key);
        if (existing) {
            material.map = existing;
            material.needsUpdate = true;
        } else {
            // 首帧前完成贴图加载，保证交互预览与无头截图一致
            try {
                const url = await resolveUrl(key);
                const texture = await new THREE.TextureLoader().loadAsync(url);
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.anisotropy = 4;
                textureCache.set(key, texture);
                material.map = texture;
                material.needsUpdate = true;
            } catch {
                // 贴图缺失时保留纯色材质
            }
        }
    }
    return material;
}

function geometryFrom(object: Scene3dObject): THREE.BufferGeometry {
    const segments = (value: unknown, fallback: number) => Math.round(num(value, fallback, 1, 256));
    switch (object.type) {
        case 'box': {
            if (typeof object.size === 'number') return new THREE.BoxGeometry(object.size, object.size, object.size);
            const size = isVec3(object.size) ? object.size : [1, 1, 1];
            return new THREE.BoxGeometry(size[0], size[1], size[2]);
        }
        case 'sphere':
            return new THREE.SphereGeometry(
                num(object.radius, 0.5, 0.001),
                segments(object.widthSegments, 32),
                segments(object.heightSegments, 24),
            );
        case 'cylinder':
            return new THREE.CylinderGeometry(
                num(object.radiusTop, 0.5, 0),
                num(object.radiusBottom, 0.5, 0),
                num(object.height, 1, 0.001),
                segments(object.radialSegments, 32),
                1,
                object.openEnded === true,
            );
        case 'cone':
            return new THREE.ConeGeometry(
                num(object.radius, 0.5, 0.001),
                num(object.height, 1, 0.001),
                segments(object.radialSegments, 32),
                1,
                object.openEnded === true,
            );
        case 'torus':
            return new THREE.TorusGeometry(
                num(object.radius, 0.5, 0.001),
                num(object.tube, 0.2, 0.0005),
                segments(object.radialSegments, 16),
                segments(object.tubularSegments, 64),
                num(object.arc, Math.PI * 2, 0.0001, Math.PI * 2),
            );
        case 'torusKnot':
            return new THREE.TorusKnotGeometry(
                num(object.radius, 0.5, 0.001),
                num(object.tube, 0.15, 0.0005),
                segments(object.tubularSegments, 128),
                segments(object.radialSegments, 16),
                Math.round(num(object.p, 2, 1, 16)),
                Math.round(num(object.q, 3, 1, 16)),
            );
        case 'plane':
            return new THREE.PlaneGeometry(
                num(object.width, 1, 0.001),
                num(object.height, 1, 0.001),
                segments(object.widthSegments, 1),
                segments(object.heightSegments, 1),
            );
        case 'ring':
            return new THREE.RingGeometry(
                num(object.innerRadius, 0.25, 0),
                num(object.outerRadius, 0.5, 0.001),
                segments(object.thetaSegments, 48),
            );
        case 'capsule':
            return new THREE.CapsuleGeometry(
                num(object.radius, 0.3, 0.001),
                num(object.length, 0.6, 0.001),
                segments(object.capSegments, 8),
                segments(object.radialSegments, 20),
            );
        default:
            return new THREE.BoxGeometry(1, 1, 1);
    }
}

function applyTransform(target: THREE.Object3D, object: Scene3dObject): void {
    if (isVec3(object.position)) target.position.set(object.position[0], object.position[1], object.position[2]);
    if (isVec3(object.rotation)) {
        target.rotation.set(
            object.rotation[0] * DEG2RAD,
            object.rotation[1] * DEG2RAD,
            object.rotation[2] * DEG2RAD,
        );
    }
    if (typeof object.scale === 'number') target.scale.setScalar(object.scale);
    else if (isVec3(object.scale)) target.scale.set(object.scale[0], object.scale[1], object.scale[2]);
    if (object.name) target.name = object.name;
}

function markShadows(object: THREE.Object3D, cast: boolean, receive: boolean): void {
    object.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
            child.castShadow = cast;
            child.receiveShadow = receive;
        }
    });
}

function boundsOf(root: THREE.Object3D): Scene3dBounds {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    return {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
        size: [size.x, size.y, size.z],
        center: [center.x, center.y, center.z],
        radius: Math.max(size.length() / 2, 0.5),
    };
}

export async function createPreview(
    canvas: HTMLCanvasElement,
    spec: Scene3dSpec,
    options: Scene3dPreviewOptions = {},
): Promise<Scene3dPreviewHandle> {
    const interactive = options.interactive !== false;
    const resolveUrl = options.resolveUrl ?? ((src: string) => src);
    const startedAt = Date.now();
    const renderSpec = spec?.render ?? {};
    const maxPixelRatio = options.maxPixelRatio ?? (interactive ? 2 : 1);

    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: renderSpec.antialias !== false,
        alpha: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = num(renderSpec.exposure, 1, 0.05, 8);
    renderer.shadowMap.enabled = renderSpec.shadows !== false;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(color(spec?.background, DEFAULT_BACKGROUND), 1);

    const scene = new THREE.Scene();
    scene.background = color(spec?.background, DEFAULT_BACKGROUND);

    const camera = new THREE.PerspectiveCamera(
        num(spec?.camera?.fov, DEFAULT_FOV, 5, 120),
        1,
        num(spec?.camera?.near, 0.01, 0.0001, 100),
        num(spec?.camera?.far, 5000, 1, 1e6),
    );

    const root = new THREE.Group();
    root.name = 'scene-root';
    scene.add(root);

    const textureCache = new Map<string, THREE.Texture>();
    const modelUrlCache = new Map<string, string>();
    const mixers: THREE.AnimationMixer[] = [];
    let animations = 0;
    let grid: THREE.GridHelper | null = null;
    let axes: THREE.AxesHelper | null = null;
    let controls: OrbitControls | null = null;
    let environment: THREE.Texture | null = null;
    let disposed = false;
    const clock = new THREE.Clock();

    const buildObject = async (object: Scene3dObject, parent: THREE.Object3D): Promise<void> => {
        if (!object || typeof object !== 'object') return;
        if (object.type === 'group') {
            const group = new THREE.Group();
            applyTransform(group, object);
            parent.add(group);
            for (const child of object.children ?? []) await buildObject(child, group);
            return;
        }

        if (object.type === 'model') {
            const src = String(object.src ?? '').trim();
            if (!src) return;
            const format = fileFormatOf(src);
            let loadedUrl = modelUrlCache.get(src);
            if (!loadedUrl) {
                loadedUrl = await resolveUrl(src);
                modelUrlCache.set(src, loadedUrl);
            }
            let modelRoot: THREE.Object3D;
            if (format === 'obj') {
                const text = await (await fetch(loadedUrl)).text();
                modelRoot = new OBJLoader().parse(text);
                if (object.material) {
                    const override = await materialFrom(object.material, textureCache, resolveUrl);
                    modelRoot.traverse((child) => {
                        const mesh = child as THREE.Mesh;
                        if (mesh.isMesh) mesh.material = override;
                    });
                }
            } else if (format === 'stl') {
                const buffer = await (await fetch(loadedUrl)).arrayBuffer();
                const stlGeometry = new STLLoader().parse(buffer);
                stlGeometry.computeVertexNormals();
                modelRoot = new THREE.Mesh(stlGeometry, await materialFrom(object.material, textureCache, resolveUrl));
            } else {
                const gltf = await new GLTFLoader().loadAsync(loadedUrl);
                modelRoot = gltf.scene;
                if (gltf.animations?.length) {
                    animations += gltf.animations.length;
                    const mixer = new THREE.AnimationMixer(modelRoot);
                    mixer.clipAction(gltf.animations[0]).play();
                    mixers.push(mixer);
                }
                if (object.material) {
                    const override = await materialFrom(object.material, textureCache, resolveUrl);
                    modelRoot.traverse((child) => {
                        const mesh = child as THREE.Mesh;
                        if (mesh.isMesh) mesh.material = override;
                    });
                }
            }
            const wrapper = new THREE.Group();
            applyTransform(wrapper, object);
            wrapper.add(modelRoot);
            markShadows(wrapper, object.castShadow !== false, object.receiveShadow !== false);
            parent.add(wrapper);
            return;
        }

        const mesh = new THREE.Mesh(geometryFrom(object), await materialFrom(object.material, textureCache, resolveUrl));
        applyTransform(mesh, object);
        mesh.castShadow = object.castShadow !== false;
        mesh.receiveShadow = object.receiveShadow !== false;
        parent.add(mesh);
    };

    const objects = Array.isArray(spec?.objects) ? spec.objects.slice(0, MAX_OBJECTS) : [];
    for (const object of objects) await buildObject(object, root);

    const bounds = boundsOf(root);
    const center = new THREE.Vector3(bounds.center[0], bounds.center[1], bounds.center[2]);
    const maxDim = Math.max(bounds.size[0], bounds.size[1], bounds.size[2], 1);

    const configureShadowCamera = (light: THREE.DirectionalLight) => {
        light.shadow.mapSize.set(2048, 2048);
        light.shadow.bias = -0.0005;
        const shadowCamera = light.shadow.camera;
        const extent = bounds.radius * 1.8;
        shadowCamera.left = -extent;
        shadowCamera.right = extent;
        shadowCamera.top = extent;
        shadowCamera.bottom = -extent;
        shadowCamera.near = 0.05;
        shadowCamera.far = Math.max(bounds.radius * 12, 20);
        shadowCamera.updateProjectionMatrix();
    };

    const buildLight = (lightSpec: Scene3dLight): THREE.Light => {
        const intensity = num(lightSpec.intensity, 1, 0, 100);
        const lightColor = color(lightSpec.color, '#ffffff');
        const position = vec3(lightSpec.position, [0, 0, 0]);
        let light: THREE.Light;
        if (lightSpec.type === 'ambient') {
            light = new THREE.AmbientLight(lightColor, intensity);
        } else if (lightSpec.type === 'point') {
            light = new THREE.PointLight(lightColor, intensity, num(lightSpec.distance, 0, 0));
            light.position.copy(position);
        } else if (lightSpec.type === 'spot') {
            const spot = new THREE.SpotLight(
                lightColor,
                intensity,
                num(lightSpec.distance, 0, 0),
                num(lightSpec.angle, 45, 1, 89) * DEG2RAD,
                num(lightSpec.penumbra, 0.2, 0, 1),
            );
            spot.position.copy(position);
            spot.target.position.copy(vec3(lightSpec.target, [0, 0, 0]));
            scene.add(spot.target);
            if (lightSpec.castShadow) {
                spot.shadow.mapSize.set(1024, 1024);
                spot.shadow.bias = -0.0005;
            }
            spot.castShadow = lightSpec.castShadow === true;
            light = spot;
        } else {
            const directional = new THREE.DirectionalLight(lightColor, intensity);
            directional.position.copy(position);
            directional.target.position.copy(vec3(lightSpec.target, [0, 0, 0]));
            scene.add(directional.target);
            directional.castShadow = lightSpec.castShadow !== false;
            if (directional.castShadow) configureShadowCamera(directional);
            light = directional;
        }
        return light;
    };

    if (Array.isArray(spec?.lights) && spec.lights.length > 0) {
        for (const lightSpec of spec.lights.slice(0, 16)) {
            if (!lightSpec || typeof lightSpec !== 'object') continue;
            scene.add(buildLight(lightSpec));
        }
    } else {
        const key = new THREE.DirectionalLight(color('#ffffff', '#ffffff'), 2.4);
        key.position.copy(center).add(new THREE.Vector3(1, 1.6, 1).multiplyScalar(maxDim * 1.4));
        key.target.position.copy(center);
        key.castShadow = renderer.shadowMap.enabled;
        configureShadowCamera(key);
        scene.add(key, key.target);

        const fill = new THREE.DirectionalLight(color('#9bb8ff', '#9bb8ff'), 0.7);
        fill.position.copy(center).add(new THREE.Vector3(-1.2, 0.8, -1).multiplyScalar(maxDim * 1.6));
        scene.add(fill);

        scene.add(new THREE.HemisphereLight(color('#e8f0ff', '#e8f0ff'), color('#1a1d23', '#1a1d23'), 0.6));
    }

    if (renderSpec.environment !== 'none') {
        try {
            const pmrem = new THREE.PMREMGenerator(renderer);
            environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
            scene.environment = environment;
            scene.environmentIntensity = 0.55;
            pmrem.dispose();
        } catch {
            environment = null;
        }
    }

    if (renderSpec.grid !== false) {
        grid = new THREE.GridHelper(maxDim * 6, 24, color('#3a4250', '#3a4250'), color('#232a35', '#232a35'));
        grid.position.set(center.x, bounds.min[1] - Math.max(maxDim * 0.001, 0.0005), center.z);
        scene.add(grid);
    }
    if (renderSpec.axes === true) {
        axes = new THREE.AxesHelper(Math.max(maxDim * 0.75, 1));
        axes.position.set(bounds.min[0], bounds.min[1], bounds.min[2]);
        scene.add(axes);
    }

    const requestedCamera = spec?.camera;
    const cameraTarget = isVec3(requestedCamera?.target)
        ? new THREE.Vector3(requestedCamera.target[0], requestedCamera.target[1], requestedCamera.target[2])
        : center;
    const applyCamera = () => {
        if (isVec3(requestedCamera?.position) && requestedCamera?.autoFrame !== true) {
            camera.position.set(requestedCamera.position[0], requestedCamera.position[1], requestedCamera.position[2]);
        } else {
            const fovRad = (camera.fov * Math.PI) / 180;
            const distance = Math.max((bounds.radius / Math.sin(fovRad / 2)) * 1.15, maxDim * 0.8);
            const direction = new THREE.Vector3(1, 0.62, 1).normalize();
            camera.position.copy(center).addScaledVector(direction, distance);
        }
        camera.lookAt(cameraTarget);
        // 超大场景把近裁剪面推远，避免深度精度不足导致 z-fighting
        camera.near = Math.max(camera.near, Math.min(bounds.radius / 1000, camera.far / 100));
        camera.far = Math.max(camera.far, bounds.radius * 100);
        camera.updateProjectionMatrix();
    };
    applyCamera();

    if (interactive) {
        controls = new OrbitControls(camera, canvas);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = Math.max(bounds.radius * 0.05, 0.01);
        controls.maxDistance = Math.max(bounds.radius * 30, 10);
        controls.target.copy(cameraTarget);
        controls.update();
    }

    const applySize = (width?: number, height?: number) => {
        const w = Math.max(1, Math.round(width ?? canvas.clientWidth ?? canvas.width ?? 1));
        const h = Math.max(1, Math.round(height ?? canvas.clientHeight ?? canvas.height ?? 1));
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    };
    applySize(options.width, options.height);

    const renderFrame = () => {
        if (disposed) return;
        renderer.render(scene, camera);
    };

    if (interactive) {
        renderer.setAnimationLoop(() => {
            const delta = clock.getDelta();
            for (const mixer of mixers) mixer.update(delta);
            controls?.update();
            renderFrame();
        });
    } else {
        renderFrame();
    }

    const collectStats = (): Scene3dStats => {
        let objectCount = 0;
        let meshes = 0;
        let triangles = 0;
        root.traverse((child) => {
            objectCount += 1;
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh || !mesh.geometry) return;
            meshes += 1;
            const geometry = mesh.geometry;
            if (geometry.index) triangles += Math.floor(geometry.index.count / 3);
            else if (geometry.attributes?.position) triangles += Math.floor(geometry.attributes.position.count / 3);
        });
        return {
            objects: objectCount,
            meshes,
            triangles,
            drawCalls: renderer.info.render.calls,
            textures: renderer.info.memory.textures,
            geometries: renderer.info.memory.geometries,
            animations,
            bounds: boundsOf(root),
            durationMs: Date.now() - startedAt,
        };
    };

    const collectPixelStats = (): Scene3dPixelStats | null => {
        if (!options.pixelStats) return null;
        const gl = renderer.getContext();
        const width = renderer.domElement.width;
        const height = renderer.domElement.height;
        if (!width || !height) return null;
        const buffer = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
        // 左上角通常是纯背景，拿它当参照，避免依赖色彩空间换算
        const background: [number, number, number, number] = [buffer[0], buffer[1], buffer[2], buffer[3]];
        let foreground = 0;
        let samples = 0;
        let lumaSum = 0;
        let minLuma = 1;
        let maxLuma = 0;
        const stride = 2;
        for (let y = 0; y < height; y += stride) {
            for (let x = 0; x < width; x += stride) {
                const index = (y * width + x) * 4;
                const r = buffer[index];
                const g = buffer[index + 1];
                const b = buffer[index + 2];
                samples += 1;
                const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
                lumaSum += luma;
                if (luma < minLuma) minLuma = luma;
                if (luma > maxLuma) maxLuma = luma;
                if (Math.abs(r - background[0]) > 8 || Math.abs(g - background[1]) > 8 || Math.abs(b - background[2]) > 8) {
                    foreground += 1;
                }
            }
        }
        return {
            coverage: samples > 0 ? foreground / samples : 0,
            meanLuma: samples > 0 ? lumaSum / samples : 0,
            minLuma,
            maxLuma,
            background,
        };
    };

    return {
        resize(width?: number, height?: number) {
            applySize(width, height);
            renderFrame();
        },
        renderOnce: renderFrame,
        resetView() {
            applyCamera();
            controls?.target.copy(cameraTarget);
            controls?.update();
            renderFrame();
        },
        setWireframe(enabled: boolean) {
            root.traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (!mesh.isMesh) return;
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                for (const material of materials) {
                    if (material && 'wireframe' in material) {
                        (material as THREE.MeshStandardMaterial).wireframe = enabled;
                        material.needsUpdate = true;
                    }
                }
            });
            renderFrame();
        },
        setGrid(enabled: boolean) {
            if (grid) grid.visible = enabled;
            renderFrame();
        },
        setAutoRotate(enabled: boolean) {
            if (controls) controls.autoRotate = enabled;
        },
        snapshot(type = 'image/png') {
            renderFrame();
            return canvas.toDataURL(type);
        },
        stats: collectStats,
        pixelStats: collectPixelStats,
        dispose() {
            if (disposed) return;
            disposed = true;
            renderer.setAnimationLoop(null);
            controls?.dispose();
            controls = null;
            scene.traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (mesh.geometry) mesh.geometry.dispose();
                const materials = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
                if (!materials) return;
                for (const material of Array.isArray(materials) ? materials : [materials]) {
                    if (!material) continue;
                    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
                        const maybeTexture = value as THREE.Texture | null;
                        if (maybeTexture && (maybeTexture as THREE.Texture).isTexture) maybeTexture.dispose();
                    }
                    material.dispose?.();
                }
            });
            for (const texture of textureCache.values()) texture.dispose();
            textureCache.clear();
            environment?.dispose();
            grid?.geometry.dispose();
            axes?.geometry.dispose();
            scene.clear();
            renderer.dispose();
        },
    };
}

/** 无头渲染入口：加载完成后立即统计一帧，供 Agent 自检 */
export async function renderPreview(
    canvas: HTMLCanvasElement,
    spec: Scene3dSpec,
    options: Scene3dPreviewOptions = {},
): Promise<{ stats: Scene3dStats; pixelStats: Scene3dPixelStats | null }> {
    const handle = await createPreview(canvas, spec, {
        interactive: false,
        pixelStats: true,
        ...options,
    });
    handle.renderOnce();
    const stats = handle.stats();
    const pixelStats = handle.pixelStats();
    handle.dispose();
    return { stats, pixelStats };
}
