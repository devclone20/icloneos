"""Blender headless v3: frost-death head close-up — ortho + sun lights.

Usage: blender -b -P render_head.py -- <model.glb> <out.png>
"""
import math
import sys

import bpy
from mathutils import Vector

# Paths come from the command line (after Blender's own `--`), never from this file.
_ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(_ARGS) != 2:
    sys.exit("usage: blender -b -P render_head.py -- <model.glb> <out.png>")
GLB, OUT = _ARGS

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
bpy.context.scene.frame_set(1)

depsgraph = bpy.context.evaluated_depsgraph_get()
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
EXCLUDE = ('backdrop', 'icosphere')
for obj in bpy.context.scene.objects:
    if obj.type != 'MESH':
        continue
    if any(k in obj.name.lower() for k in EXCLUDE):
        obj.hide_render = True
        continue
    ev = obj.evaluated_get(depsgraph)
    mesh = ev.to_mesh()
    mw = ev.matrix_world
    for v in mesh.vertices:
        w = mw @ v.co
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))
    ev.to_mesh_clear()

size = hi - lo
print('BOUNDS', tuple(round(x,4) for x in lo), tuple(round(x,4) for x in hi))

head_c = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z + size.z * 0.845))
frame_h = size.z * 0.60            # whole helmet + ear cups + antennas, with margin

cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = frame_h
cam_data.clip_start = size.z * 0.01
cam_data.clip_end = size.z * 100
cam = bpy.data.objects.new('cam', cam_data)
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam

azim = math.radians(88)            # PURE right profile — fins left, i01 arm right (the reference)
elev = math.radians(4)
dist = size.z * 3
cam.location = head_c + Vector((
    dist * math.cos(elev) * math.sin(azim),
    -dist * math.cos(elev) * math.cos(azim),
    dist * math.sin(elev)
))
cam.rotation_euler = (head_c - cam.location).to_track_quat('-Z', 'Y').to_euler()

def sun(name, azim_deg, elev_deg, energy, color):
    data = bpy.data.lights.new(name, 'SUN')
    data.energy = energy
    data.color = color
    data.angle = math.radians(12)
    ob = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(ob)
    a, e = math.radians(azim_deg), math.radians(elev_deg)
    direction = -Vector((math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)))
    ob.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

sun('key', 235, 35, 3.2, (1.0, 0.97, 0.9))
sun('fill', 150, 10, 1.1, (0.85, 0.92, 1.0))
sun('rim', 20, 25, 2.6, (0.55, 0.95, 0.95))

world = bpy.data.worlds.new('w')
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs[0].default_value = (0.55, 0.6, 0.65, 1)
bg.inputs[1].default_value = 0.35
bpy.context.scene.world = world

scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.film_transparent = True
scene.render.resolution_x = 1440
scene.render.resolution_y = 1440
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print('RENDER-DONE')
sys.exit(0)
