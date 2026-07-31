import math
import sys
from pathlib import Path

import bpy


def arg_after(flag: str, default: str | None = None) -> str:
    if flag in sys.argv:
        idx = sys.argv.index(flag)
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]
    if default is None:
        raise SystemExit(f"missing required argument: {flag}")
    return default


src = Path(arg_after("--src")).resolve()
out = Path(arg_after("--out")).resolve()
out.parent.mkdir(parents=True, exist_ok=True)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()

bpy.ops.import_scene.gltf(filepath=str(src))

objects = [obj for obj in bpy.context.scene.objects if obj.type in {"MESH", "EMPTY"}]
if not objects:
    raise SystemExit("no mesh or empty objects imported")

root = bpy.data.objects.new("snow_leopard_animation_root", None)
bpy.context.collection.objects.link(root)

for obj in list(bpy.context.scene.objects):
    if obj is root:
        continue
    if obj.parent is None:
        obj.parent = root

bpy.context.scene.frame_start = 1
bpy.context.scene.frame_end = 48
bpy.context.scene.render.fps = 24

root.rotation_mode = "XYZ"
root.location = (0.0, 0.0, 0.0)

keyframes = [
    (1, 0.0, 0.0, 0.00),
    (12, math.radians(1.5), math.radians(-4.0), 0.03),
    (24, math.radians(-1.0), math.radians(3.0), 0.00),
    (36, math.radians(1.0), math.radians(-2.0), -0.02),
    (48, 0.0, 0.0, 0.00),
]

for frame, roll, yaw, z in keyframes:
    bpy.context.scene.frame_set(frame)
    root.rotation_euler = (0.0, yaw, roll)
    root.location = (0.0, 0.0, z)
    root.keyframe_insert(data_path="rotation_euler", frame=frame)
    root.keyframe_insert(data_path="location", frame=frame)

if root.animation_data and root.animation_data.action and hasattr(root.animation_data.action, "fcurves"):
    root.animation_data.action.name = "friendly_idle_wave_sway"
    for fcurve in root.animation_data.action.fcurves:
        for point in fcurve.keyframe_points:
            point.interpolation = "BEZIER"
        cycle = fcurve.modifiers.new(type="CYCLES")
        cycle.mode_before = "REPEAT"
        cycle.mode_after = "REPEAT"
elif root.animation_data and root.animation_data.action:
    root.animation_data.action.name = "friendly_idle_wave_sway"

for obj in bpy.context.scene.objects:
    obj.select_set(True)

bpy.ops.export_scene.gltf(
    filepath=str(out),
    export_format="GLB",
    export_animations=True,
    export_frame_range=True,
    export_frame_step=1,
    export_force_sampling=True,
)

print(f"exported {out}")
