import { defineComponent } from "@openuidev/react-lang";
import { lazy, Suspense, useMemo } from "react";
import { z } from "zod";
import type { Group } from "../kit.js";
import { prepareSceneObjects } from "../gpu/expression.js";
import { shaderErrors } from "../gpu/shader-args.js";
import type { Props } from "../gpu/values.js";

const SceneView = lazy(() => import("../gpu/SceneView.js").then((module) => ({ default: module.Scene })));
const ShaderView = lazy(() => import("../gpu/Shader.js").then((module) => ({ default: module.Shader })));
const camera = z.object({ yaw: z.number().optional(), pitch: z.number().optional(), zoom: z.number().optional() });
const inputs = z.record(z.string(), z.union([z.number(), z.boolean()]));
const height = z.number().min(120).max(720).optional();
const pending = (height: number | undefined) => <div role="status" className="flex min-w-0 items-center justify-center text-xs text-muted-foreground" style={{ height: height ?? 320 }}>Loading graphics…</div>;

const Scene = defineComponent({
  name: "Scene",
  props: z.object({
    objects: z.union([z.array(z.record(z.string(), z.unknown())), z.string()]),
    height,
    camera: camera.optional(),
    spin: z.number().optional(),
    animate: z.boolean().optional(),
    orbit: z.boolean().optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }),
  description: 'Interactive 3D scene. Objects use shape: box, sphere, cylinder, surface, mesh, line, path, point, label, grid, axes, model, environment, sprite. Positions use at:[x,y,z], with y up. Materials take color (theme token or #rrggbb), roughness, metal, glow, glass, ior, dispersion, texture. Model src is a local embedded GLB/glTF; environment src is HDR or an image. A surface uses x:[min,max], z:[min,max], values:height rows or f:a quoted OpenUI expression such as "@Sin($x)*@Cos($z)". objects may be a quoted array expression using $t in seconds. Named inputs are available as $name. Use @Sin/@Cos and the native OpenUI math functions, never JavaScript. Orbit by drag, pinch or ctrl-wheel; double-click resets. GPU contexts pause off screen. System reduced motion and Pages Animations apply.',
  component: ({ props }) => {
    const objects = useMemo(() => prepareSceneObjects(props.objects, props.inputs), [props.objects, props.inputs]);
    const adapted: Props = { ...props, objects } as Props;
    return <Suspense fallback={pending(props.height)}><SceneView props={adapted} /></Suspense>;
  },
});

const Shader = defineComponent({
  name: "Shader",
  props: z.object({
    code: z.string(),
    height,
    inputs: inputs.optional(),
    buffers: z.array(z.string()).max(4).optional(),
    textures: z.array(z.string()).max(4).optional(),
    animate: z.boolean().optional(),
    blend: z.enum(["light", "alpha", "opaque"]).optional(),
    bloom: z.number().min(0).max(3).optional(),
    orbit: z.boolean().optional(),
    spin: z.number().optional(),
    camera: camera.optional(),
  }),
  description: 'Shadertoy-style WebGL2 shader: code defines void mainImage(out vec4 fragColor, in vec2 fragCoord). Uniforms include iResolution, iTime, iTimeDelta, iFrame, iMouse, iCamera, iNoise. Named inputs become float uniforms; booleans are 0/1. Up to four buffers run before the image, with ping-pong feedback as iChannel0-3; textures are iTexture0-3. Inputs update uniforms without recompilation. blend is light (black transparent), alpha, or opaque; bloom preserves HDR light. Optional orbit camera, spin, and live height. Rendering pauses off screen and respects reduced motion. No network from shaders; textures load through Pages.',
  component: ({ props }) => {
    const adapted = props as Props;
    const errors = shaderErrors(adapted);
    if (errors.length) return <div>{errors.map((error) => <p key={error} role="alert" className="m-0 text-xs text-destructive">{error}</p>)}</div>;
    return <Suspense fallback={pending(props.height)}><ShaderView props={adapted} /></Suspense>;
  },
});

export const group: Group = {
  id: "gpu", name: "3D & shaders",
  notes: ["Use the existing OpenUI expression syntax for scene functions. Scene expressions cannot execute JavaScript or access the network. Models must embed every buffer and texture; external model references are refused."],
  entries: [
    { component: Scene, summary: "3D solids, surfaces, models, labels, and materials", examples: [
      { name: "Solids and labels", code: `root = Scene([{shape: "box", at: [-1, 0.5, 0], size: 1, color: "accent"}, {shape: "sphere", at: [0.7, 0.65, 0], radius: 0.65, color: "chart3", metal: 0.3}, {shape: "grid", size: 5}, {shape: "axes", size: 2}, {shape: "label", at: [-1, 1.3, 0], text: "Box"}])` },
      { name: "Sampled surface", code: `root = Scene([{shape: "surface", x: [-3, 3], z: [-3, 3], f: "@Sin($x) * @Cos($z)", detail: 40, colors: ["chart2", "accent", "chart3"]}, {shape: "axes", size: 3}], 320)` },
      { name: "Animated orbit", code: `root = Scene(${JSON.stringify('[{shape: "sphere", at: [@Cos($t) * 1.2, 0.6, @Sin($t) * 1.2], radius: 0.4, color: "accent"}, {shape: "sphere", at: [0, 0.6, 0], radius: 0.25, color: "chart4", glow: 0.5}, {shape: "grid", size: 4}]')}, 280)` },
      { name: "Glass and glow", code: `root = Scene([{shape: "sphere", at: [-0.8, 0.7, 0], radius: 0.7, color: "accent", glass: true, roughness: 0.05}, {shape: "box", at: [0.8, 0.5, 0], color: "chart4", glow: 0.8}, {shape: "grid", size: 5}], 280)` },
    ] },
    { component: Shader, summary: "GLSL, feedback buffers, textures, and live uniforms", examples: [
      { name: "Animated light", code: `root = Shader(${JSON.stringify('void mainImage(out vec4 c, in vec2 p) { vec2 uv = (p - 0.5 * iResolution.xy) / iResolution.y; float light = 0.02 / max(0.015, abs(length(uv) - 0.2 - 0.04 * sin(iTime))); c = vec4(vec3(0.2, 0.55, 1.0) * light, 1.0); }')}, 240)` },
      { name: "Live input", code: `$speed = 1\nroot = Stack([Slider("speed", 0, 3, 0.1, "Speed", $speed), Shader(${JSON.stringify('void mainImage(out vec4 c, in vec2 p) { vec2 uv = p / iResolution.xy; c = vec4(0.5 + 0.5 * cos(iTime * speed + uv.xyx * 6.0 + vec3(0.0, 2.0, 4.0)), 1.0); }')}, 220, {speed: $speed}, [], [], true, "opaque")])` },
      { name: "Feedback buffer", code: `root = Shader(${JSON.stringify('void mainImage(out vec4 c, in vec2 p) { c = texture(iChannel0, p / iResolution.xy); }')}, 220, {}, [${JSON.stringify('void mainImage(out vec4 c, in vec2 p) { vec2 uv = p / iResolution.xy; vec3 previous = texture(iChannel0, uv).rgb * 0.96; vec2 center = 0.5 + 0.25 * vec2(cos(iTime), sin(iTime * 1.3)); float dotLight = exp(-500.0 * dot(uv - center, uv - center)); c = vec4(previous + dotLight * vec3(0.1, 0.4, 0.8), 1.0); }')}])` },
    ] },
  ],
};
