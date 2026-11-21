# Imports a Handhold .glb onto a skeleton already in an Unreal project, as animations only (the way docs/unreal.md says), and checks
# in Unreal's own numbers that each animation puts every bone where the .glb has it at its first key, and that the socket in the pose
# file puts the prop where the .glb holds it. Run it headless in a project that has the skeleton:
#
#   UnrealEditor-Cmd.exe P.uproject -run=pythonscript -script="scripts/check-unreal.py x.glb x.pose.json /Game/Path/SK_Skeleton"
#       -unattended -nullrhi -nosplash -nosound -nopause -stdout -AllowStdOutLogVerbosity
#
# The character in the .glb must be the one the skeleton came from (exported from Unreal as .glb, docs/unreal.md step 1).
# Prints lines that start "HH " and ends with "HH RESULT PASS" or "HH RESULT FAIL".
import json
import math
import re
import struct
import sys

import unreal

GLB, POSE, SKELETON = sys.argv[1:4]
DEST = "/Game/HandholdCheck"
BONE_CM = 0.1  # how far a bone may be from the .glb (cm)
PROP_CM = 0.1
PROP_DEG = 0.2

log = lambda *a: unreal.log("HH " + " ".join(str(x) for x in a))
eal = unreal.EditorAssetLibrary


# ---- the .glb: each animation's first key, laid over the nodes, gives every bone and the prop in glTF space (metres, Y up)
def read_glb(path):
    b = open(path, "rb").read()
    n = struct.unpack_from("<I", b, 12)[0]
    j = json.loads(b[20 : 20 + n])
    off = 20 + n
    size = struct.unpack_from("<I", b, off)[0]
    return j, b[off + 8 : off + 8 + size]


def values(j, data, i):
    a = j["accessors"][i]
    v = j["bufferViews"][a["bufferView"]]
    k = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[a["type"]]
    start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = v.get("byteStride", 4 * k)
    return [struct.unpack_from("<%df" % k, data, start + c * stride) for c in range(a["count"])]


def trs(t, q, s):
    x, y, z, w = q
    r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    return [[r[i][0] * s[0], r[i][1] * s[1], r[i][2] * s[2], t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


j, data = read_glb(GLB)
nodes = j["nodes"]
parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
joints = set(j["skins"][0]["joints"]) if j.get("skins") else set()


def scene(overrides):
    local = {}
    for i, n in enumerate(nodes):
        t = list(n.get("translation", [0, 0, 0]))
        q = list(n.get("rotation", [0, 0, 0, 1]))
        s = list(n.get("scale", [1, 1, 1]))
        for path, v in overrides.get(i, {}).items():
            if path == "translation":
                t = list(v)
            elif path == "rotation":
                q = list(v)
            elif path == "scale":
                s = list(v)
        local[i] = trs(t, q, s)
    world = {}

    def at(i):
        if i not in world:
            world[i] = mul(at(parent[i]), local[i]) if i in parent else local[i]
        return world[i]

    for i in range(len(nodes)):
        at(i)
    return world


def keys(anim, k):
    """Each channel's key k (0 the first, -1 the last), by node and path."""
    o = {}
    for c in anim["channels"]:
        s = anim["samplers"][c["sampler"]]
        o.setdefault(c["target"]["node"], {})[c["target"]["path"]] = values(j, data, s["output"])[k]
    return o


def duration(anim):
    return max(values(j, data, s["input"])[-1][0] for s in anim["samplers"])


# the prop: a node with a mesh and no skin, somewhere under a bone
prop = None
for i, n in enumerate(nodes):
    if n.get("mesh") is None or n.get("skin") is not None:
        continue
    # the prop's own origin is the top node of its file, the one hung on the bone (its meshes may sit away from it)
    top, p = i, parent.get(i)
    while p is not None and p not in joints:
        top, p = p, parent.get(p)
    if p is not None:
        prop = top


def to_ue(v, scale=100):
    return unreal.Vector(v[0] * scale, v[2] * scale, v[1] * scale)


def col(m, c):
    return [m[0][c], m[1][c], m[2][c]]


# ---- import it the way the guide says: onto the skeleton, animations only
skel = unreal.load_asset(SKELETON)
if not skel:
    log("FAIL no skeleton at", SKELETON)
    log("RESULT FAIL")
    raise SystemExit
if eal.does_directory_exist(DEST):
    eal.delete_directory(DEST)
# the glTF pipeline the import dialog shows, loaded by path (a headless run has not scanned the engine's assets)
gltf = unreal.load_asset("/Interchange/Pipelines/DefaultGLTFAssetsPipeline")
pipe = unreal.AssetToolsHelpers.get_asset_tools().duplicate_asset("Pipeline", DEST, gltf)
common = pipe.get_editor_property("common_skeletal_meshes_and_animations_properties")
common.set_editor_property("skeleton", skel)
common.set_editor_property("import_only_animations", True)
params = unreal.ImportAssetParameters()
params.is_automated = True
params.override_pipelines.append(unreal.SoftObjectPath(pipe.get_path_name()))
manager = unreal.InterchangeManager.get_interchange_manager_scripted()
manager.import_asset(DEST, unreal.InterchangeManager.create_source_data(GLB), params)

made = {}
for path in eal.list_assets(DEST, recursive=True, include_folder=False):
    a = unreal.load_asset(path)
    if isinstance(a, unreal.AnimSequence):
        made[a.get_name()] = a
    elif a != pipe:
        log("FAIL the import also made", a.get_class().get_name(), path)
log("animations made", sorted(made))

ok = True
squash = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
opts = unreal.AnimPoseEvaluationOptions()
WORLD = unreal.AnimPoseSpaces.WORLD
pose_file = json.load(open(POSE))
socket = None
u = pose_file.get("unreal")
if u:
    r = u["rotation"]
    socket = unreal.Transform(unreal.Vector(*u["location"]), unreal.Rotator(roll=r["roll"], pitch=r["pitch"], yaw=r["yaw"]), unreal.Vector(*u["scale"]))
    # the rotator in the file against Unreal's own reading of the same turn
    q = pose_file["objectInHandBone"]["quaternion"]
    back = unreal.Quat(-q[0], -q[2], -q[1], q[3])
    there = socket.rotation
    turn = math.degrees(2 * math.acos(min(1, abs(back.x * there.x + back.y * there.y + back.z * there.z + back.w * there.w))))
    log("socket on", u["socketBone"], "rotation off Unreal's own by %.4f degrees" % turn)
    if turn > PROP_DEG:
        ok = False
names = {i: n.get("name") for i, n in enumerate(nodes)}

for anim in j.get("animations", []):
    name = anim["name"]
    found = [a for k, a in made.items() if squash(k).endswith(squash(name))]
    found.sort(key=lambda a: len(a.get_name()))
    if not found:
        ok = False
        log("FAIL nothing made for", name)
        continue
    a = found[0]
    length = unreal.AnimationLibrary.get_sequence_length(a)
    log("anim", a.get_name(), "for", repr(name), "%.3f s (.glb %.3f)" % (length, duration(anim)))
    if abs(length - duration(anim)) > 0.02:
        ok = False
        log("FAIL", a.get_name(), "is not as long as the .glb's")
    # its first key and its last: the start and end of a swing, both ends of a look
    for k, t, which in ((0, 0.0, "first key"), (-1, length, "last key")):
        want = scene(keys(anim, k))
        pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(a, t, opts)
        worst, where = 0, None
        for i in joints:
            got = unreal.AnimPoseExtensions.get_bone_pose(pose, names[i], WORLD).translation
            d = (got - to_ue(col(want[i], 3))).length()
            if d > worst:
                worst, where = d, names[i]
        line = ["  ", which, "%d bones, worst %.4f cm at %s" % (len(joints), worst, where)]
        bad = worst > BONE_CM
        if socket and prop is not None:
            hand = unreal.AnimPoseExtensions.get_bone_pose(pose, u["socketBone"], WORLD)
            held = unreal.MathLibrary.compose_transforms(socket, hand)
            m = want[prop]
            d = (held.translation - to_ue(col(m, 3))).length()
            # the prop's own axes: glTF x, y and z are Unreal's x, z and y
            ax = []
            for c, axis in ((0, unreal.Vector(1, 0, 0)), (1, unreal.Vector(0, 0, 1)), (2, unreal.Vector(0, 1, 0))):
                g = to_ue(col(m, c), 1)
                v = unreal.MathLibrary.transform_direction(held, axis)
                ax.append(math.degrees(math.acos(max(-1, min(1, v.normal().dot(g.normal()))))))
            sc = math.sqrt(sum(x * x for x in col(m, 0)))
            line.append("| prop off %.4f cm, axes off %.4f deg, scale %.4f (.glb %.4f)" % (d, max(ax), held.scale3d.x, sc))
            bad = bad or d > PROP_CM or max(ax) > PROP_DEG or abs(held.scale3d.x - sc) > 0.001
        if bad:
            ok = False
            line[0] = "FAIL"
        log(*line)
log("RESULT", "PASS" if ok else "FAIL")
