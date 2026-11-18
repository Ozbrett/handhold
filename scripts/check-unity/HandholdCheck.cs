// Checks the Unity export against the app's own answer, with no window:
//
//   Unity -batchmode -nographics -projectPath <project> -executeMethod HandholdCheck.Run -quit
//
// The project must have the exported .unitypackage imported, this file under
// Assets/Editor, and the fixture written by scripts/try-models.mjs at
// Assets/HandholdCheck/fixture.json.
// Import the package in a run of its own first
// (Unity -batchmode -nographics -quit -projectPath <project> -importPackage <file>):
// asked to import and execute in one run, Unity executes before the import lands.
//
// A skeleton is built from the fixture's rest positions, the exported pose is
// applied to it by the real HandholdGrip component, and every bone is compared
// with where the app put it. It is done twice: once with the bones as the file
// has them, and once "twisted" - under a turned, scaled and moved parent, with
// different bone axes and differently punctuated names - the way a character
// from another importer might arrive.
//
// Saved poses, animations and looks are then shown by name: a pose called
// "Held" has to land on the exported hold, a look has to follow the camera on
// the arc the app drew (straight ahead, fully up, fully right), and an
// animation has to play, move the hand, and end (or loop) as the file says.

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;

public static class HandholdCheck
{
    [Serializable] class Tq { public float[] p; public float[] q; }
    [Serializable] class FBone { public string name; public string parent; public Tq rest; public Tq posed; public bool second; }
    [Serializable] class Fixture { public FBone[] bones; }
    [Serializable] class Trs { public float[] position; public float[] quaternion; }
    [Serializable] class SweepKey { public float t; }
    [Serializable] class NamedHead { public string name; }
    [Serializable] class ClipHead { public string name; public float duration; public bool loops; }
    [Serializable] class LookHead { public string name; public float[] yaw; public float[] pitch; }
    [Serializable] class ArmHead { public SweepKey[] sweep; public float[] forward; public NamedHead[] poses; public ClipHead[] clips; public LookHead[] looks; }
    [Serializable] class SecondHead { public string handBone; }
    [Serializable] class PoseHead { public string handBone; public Trs objectAtRest; public ArmHead arm; public SecondHead secondHand; }

    static readonly Vector3 ProbeOffset = new Vector3(0.011f, 0.023f, -0.017f);

    // model space (right-handed) -> Unity (left-handed)
    static Vector3 Mirror(Vector3 p) { return new Vector3(-p.x, p.y, p.z); }
    static Quaternion Mirror(Quaternion q) { return new Quaternion(q.x, -q.y, -q.z, q.w); }
    static Vector3 V(float[] p) { return new Vector3(p[0], p[1], p[2]); }
    static Quaternion Q(float[] q) { return new Quaternion(q[0], q[1], q[2], q[3]); }

    public static void Run()
    {
        int code = 1;
        try { code = Check() ? 0 : 1; }
        catch (Exception e) { Debug.LogError("HANDHOLD_CHECK exception: " + e); }
        Debug.Log("HANDHOLD_CHECK RESULT " + (code == 0 ? "PASS" : "FAIL"));
        EditorApplication.Exit(code);
    }

    static void Call(object target, string method)
    {
        target.GetType().GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).Invoke(target, null);
    }

    static bool Check()
    {
        var fixture = JsonUtility.FromJson<Fixture>(File.ReadAllText("Assets/HandholdCheck/fixture.json"));
        TextAsset pose = null;
        foreach (string guid in AssetDatabase.FindAssets("t:TextAsset", new[] { "Assets/Handhold" }))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            if (path.EndsWith(".pose.json")) pose = AssetDatabase.LoadAssetAtPath<TextAsset>(path);
        }
        if (!pose) { Debug.LogError("HANDHOLD_CHECK no .pose.json under Assets/Handhold: was the package imported?"); return false; }
        Debug.Log("HANDHOLD_CHECK pose " + AssetDatabase.GetAssetPath(pose) + ", " + fixture.bones.Length + " bones in the fixture");
        bool ok = true;
        ok &= One(fixture, pose, false);
        ok &= One(fixture, pose, true);
        return ok;
    }

    class Rig
    {
        public GameObject root; public Transform wrapper, prop;
        public Dictionary<string, Transform> bones = new Dictionary<string, Transform>();
        public Dictionary<string, Transform> probes = new Dictionary<string, Transform>();
        public HandholdGrip grip;
    }

    static Rig Build(Fixture fixture, TextAsset pose, bool twisted, HandholdGrip.ArmMode mode)
    {
        var rig = new Rig();
        rig.root = new GameObject("Character");
        rig.root.transform.position = new Vector3(3f, 1f, -2f);
        rig.root.transform.rotation = Quaternion.Euler(0f, 40f, 0f);
        rig.wrapper = new GameObject("Armature").transform;
        rig.wrapper.SetParent(rig.root.transform, false);
        if (twisted)
        {
            rig.wrapper.localPosition = new Vector3(0.2f, -0.1f, 0.3f);
            rig.wrapper.localRotation = Quaternion.Euler(-90f, 25f, 10f);
            rig.wrapper.localScale = Vector3.one * 0.37f;
        }
        int i = 0;
        foreach (FBone b in fixture.bones)
        {
            // the fixture has the app's tidied names ("mixamorigRightHand"), the pose file the original ones
            // ("mixamorig:RightHand"); the twisted run uses a third spelling
            var t = new GameObject(twisted ? b.name.Replace("mixamorig", "mixamorig_") : b.name).transform;
            Transform parent;
            if (string.IsNullOrEmpty(b.parent) || !rig.bones.TryGetValue(b.parent, out parent)) parent = rig.wrapper;
            t.SetParent(parent, false);
            t.position = rig.wrapper.TransformPoint(Mirror(V(b.rest.p)));
            t.rotation = rig.wrapper.rotation * (twisted ? Quaternion.Euler(13f * i, 29f * i, 47f * i) : Mirror(Q(b.rest.q)));
            rig.bones[b.name] = t;
            var probe = new GameObject("probe").transform;
            probe.SetParent(t, false);
            probe.position = rig.wrapper.TransformPoint(Mirror(V(b.rest.p) + ProbeOffset));
            rig.probes[b.name] = probe;
            i++;
        }
        rig.prop = new GameObject("Prop").transform;
        rig.prop.position = new Vector3(-5f, 0f, 9f);
        rig.grip = rig.root.AddComponent<HandholdGrip>();
        rig.grip.poseJson = pose;
        rig.grip.heldObject = rig.prop;
        rig.grip.armMode = mode;
        rig.grip.aimSmoothing = 0f;
        Call(rig.grip, "Start");
        return rig;
    }

    static bool One(Fixture fixture, TextAsset pose, bool twisted)
    {
        string label = twisted ? "twisted" : "plain";
        Rig rig = Build(fixture, pose, twisted, HandholdGrip.ArmMode.Hold);
        if (!rig.grip.IsReady) { Debug.LogError("HANDHOLD_CHECK " + label + ": the component did not load the pose"); return false; }
        // a pose exported with a sweep leaves the app at the sweep's end
        var head = JsonUtility.FromJson<PoseHead>(pose.text);
        bool hasSweep = head.arm != null && head.arm.sweep != null && head.arm.sweep.Length >= 2;
        rig.grip.sweep = hasSweep ? 1f : 0f;
        Call(rig.grip, "LateUpdate");

        float scale = rig.wrapper.lossyScale.x;
        float span = 0f;
        foreach (FBone b in fixture.bones) span = Mathf.Max(span, (V(b.rest.p) - V(fixture.bones[0].rest.p)).magnitude * scale);

        float worstBone = 0f, worstProbe = 0f;
        string worstName = "";
        foreach (FBone b in fixture.bones)
        {
            Vector3 wantBone = rig.wrapper.TransformPoint(Mirror(V(b.posed.p)));
            Quaternion turned = Q(b.posed.q) * Quaternion.Inverse(Q(b.rest.q));
            Vector3 wantProbe = rig.wrapper.TransformPoint(Mirror(V(b.posed.p) + turned * ProbeOffset));
            float eb = (rig.bones[b.name].position - wantBone).magnitude;
            worstBone = Mathf.Max(worstBone, eb);
            float e = (rig.probes[b.name].position - wantProbe).magnitude;
            if (e > 0.01f * span || eb > 0.01f * span)
                Debug.Log(string.Format("HANDHOLD_CHECK {0}:   off: {1} bone {2:F5}, riding point {3:F5}", label, b.name, eb, e));
            if (e > worstProbe) { worstProbe = e; worstName = b.name; }
        }
        Debug.Log(string.Format("HANDHOLD_CHECK {0}: bones worst {1:F5} ({2:F2}% of span {3:F3}), points riding on bones worst {4:F5} ({5:F2}%, {6})",
            label, worstBone, 100f * worstBone / span, span, worstProbe, 100f * worstProbe / span, worstName));
        bool ok = worstBone < 0.01f * span && worstProbe < 0.01f * span;

        // two-handed grips: the second hand has to be found, and has to be on its spot
        bool twoHanded = head.secondHand != null && !string.IsNullOrEmpty(head.secondHand.handBone);
        if (twoHanded)
        {
            float gap = rig.grip.SecondHandGap();
            int secondBones = 0;
            foreach (FBone b in fixture.bones) if (b.second) secondBones++;
            Debug.Log(string.Format("HANDHOLD_CHECK {0}: second hand {1}, {2} of its bones in the fixture, {3:F5} from its spot ({4:F2}%)",
                label, rig.grip.HasSecondHand ? "loaded" : "NOT loaded", secondBones, gap, 100f * gap / span));
            ok &= rig.grip.HasSecondHand && gap < 0.01f * span;
        }

        // the prop: where the object sat at rest, carried along by the hand's own motion
        FBone handBone = null;
        string loose = head.handBone.Replace(":", "");
        foreach (FBone b in fixture.bones) if (b.name == loose) handBone = b;
        if (handBone != null && head.objectAtRest != null && head.objectAtRest.position != null && head.objectAtRest.position.Length == 3)
        {
            Quaternion carried = Q(handBone.posed.q) * Quaternion.Inverse(Q(handBone.rest.q));
            Vector3 at = V(handBone.posed.p) + carried * (V(head.objectAtRest.position) - V(handBone.rest.p));
            Quaternion facing = carried * Q(head.objectAtRest.quaternion);
            float propOff = (rig.prop.position - rig.wrapper.TransformPoint(Mirror(at))).magnitude;
            float propTurn = Quaternion.Angle(rig.prop.rotation, rig.wrapper.rotation * Mirror(facing));
            Debug.Log(string.Format("HANDHOLD_CHECK {0}: prop {1:F5} from where the app put it ({2:F2}% of span), turned {3:F2} deg from it; parented to {4}",
                label, propOff, 100f * propOff / span, propTurn, rig.prop.parent ? rig.prop.parent.name : "nothing"));
            ok &= propOff < 0.02f * span && propTurn < 2f && rig.prop.parent == rig.bones[handBone.name];
        }
        else Debug.Log("HANDHOLD_CHECK " + label + ": no prop in the pose to compare");

        // Animation mode: the arm is left alone, and the fingers sit in the hand exactly as in the held pose
        if (handBone != null)
        {
            Rig free = Build(fixture, pose, twisted, HandholdGrip.ArmMode.Animation);
            Call(free.grip, "LateUpdate");
            float armMoved = 0f, fingerOff = 0f;
            Transform handHeld = rig.bones[handBone.name], handFree = free.bones[handBone.name];
            foreach (FBone b in fixture.bones)
            {
                bool isArm = b == handBone || b.name == handBone.parent || IsParentOf(fixture, b.name, handBone.parent);
                if (b.second) continue;   // the second arm reaches for the first hand, wherever the animation put it
                if (isArm)
                    armMoved = Mathf.Max(armMoved, (free.bones[b.name].position - free.wrapper.TransformPoint(Mirror(V(b.rest.p)))).magnitude);
                else
                    fingerOff = Mathf.Max(fingerOff, (handFree.InverseTransformPoint(free.probes[b.name].position) - handHeld.InverseTransformPoint(rig.probes[b.name].position)).magnitude * scale);
            }
            Debug.Log(string.Format("HANDHOLD_CHECK {0}: animation mode leaves the arm alone (moved {1:F5}), fingers match the held pose within the hand to {2:F5} ({3:F2}%)",
                label, armMoved, fingerOff, 100f * fingerOff / span));
            ok &= armMoved < 1e-4f * span + 1e-6f && fingerOff < 0.01f * span;
            UnityEngine.Object.DestroyImmediate(free.root);
            UnityEngine.Object.DestroyImmediate(free.prop ? free.prop.gameObject : null);

            Rig aim = Build(fixture, pose, twisted, HandholdGrip.ArmMode.FollowCamera);
            var camera = new GameObject("Aim").transform;
            aim.grip.aimSource = camera;
            if (hasSweep)
            {
                // Follow camera along a sweep: looking all the way up is the end of the sweep, all the way down its start
                camera.rotation = aim.root.transform.rotation * Quaternion.Euler(-aim.grip.aimUp, 0f, 0f);
                Call(aim.grip, "LateUpdate");
                float topOff = (aim.bones[handBone.name].position - handHeld.position).magnitude;
                Vector3 top = aim.bones[handBone.name].position;
                camera.rotation = aim.root.transform.rotation * Quaternion.Euler(-aim.grip.aimDown, 0f, 0f);
                Call(aim.grip, "LateUpdate");
                float travel = (aim.bones[handBone.name].position - top).magnitude;
                Debug.Log(string.Format("HANDHOLD_CHECK {0}: follow-camera along the sweep: looking fully up puts the hand {1:F5} from the sweep's end ({2:F2}%); looking fully down moves it {3:F3} ({4:F0}% of span) to the start",
                    label, topOff, 100f * topOff / span, travel, 100f * travel / span));
                ok &= topOff < 0.01f * span && travel > 0.05f * span;
            }
            else
            {
                // Follow camera, no sweep: looking up 30 degrees swings the whole held arm 30 degrees up about the shoulder
                camera.rotation = aim.root.transform.rotation * Quaternion.Euler(-30f, 0f, 0f);
                Call(aim.grip, "LateUpdate");
                Transform shoulderHeld = rig.bones[fixture.bones[0].name], shoulderAim = aim.bones[fixture.bones[0].name];
                Vector3 heldArm = handHeld.position - shoulderHeld.position;
                Vector3 want = shoulderAim.position + Quaternion.AngleAxis(-30f, aim.root.transform.right) * heldArm;
                float aimOff = (aim.bones[handBone.name].position - want).magnitude;
                float lift = aim.bones[handBone.name].position.y - handHeld.position.y;
                Debug.Log(string.Format("HANDHOLD_CHECK {0}: follow-camera, looking 30 deg up: hand {1:F5} from the expected arc ({2:F2}%), raised by {3:F3}",
                    label, aimOff, 100f * aimOff / span, lift));
                ok &= aimOff < 0.01f * span && lift > 0f;
            }
            if (twoHanded)
            {
                // swinging the first arm can carry the object further than the second arm reaches:
                // then the second hand has to end at full stretch, as close as it can get
                float gap = aim.grip.SecondHandGap();
                Transform h2 = aim.bones[head.secondHand.handBone.Replace(":", "")], f2 = h2.parent, u2 = f2.parent;
                float reach = (f2.position - u2.position).magnitude + (h2.position - f2.position).magnitude;
                float shortBy = Mathf.Max(0f, (aim.grip.SecondHandSpot() - u2.position).magnitude - reach);
                Debug.Log(string.Format("HANDHOLD_CHECK {0}: follow-camera: the second hand stays {1:F5} from its spot ({2:F2}%); out of the arm's reach by {3:F5}",
                    label, gap, 100f * gap / span, shortBy));
                ok &= gap < shortBy + 0.01f * span;
            }
            UnityEngine.Object.DestroyImmediate(aim.root);
            UnityEngine.Object.DestroyImmediate(camera.gameObject);
        }
        if (handBone != null && head.arm != null) ok &= Saved(fixture, pose, twisted, head, rig, handBone, span);
        UnityEngine.Object.DestroyImmediate(rig.root);
        return ok;
    }

    static void Destroy(Rig r)
    {
        UnityEngine.Object.DestroyImmediate(r.root);
        UnityEngine.Object.DestroyImmediate(r.prop ? r.prop.gameObject : null);
    }

    // Saved poses, animations and looks, shown by name on a character whose own animation has the arm
    static bool Saved(Fixture fixture, TextAsset pose, bool twisted, PoseHead head, Rig held, FBone handBone, float span)
    {
        string label = twisted ? "twisted" : "plain";
        bool ok = true;
        Transform handHeld = held.bones[handBone.name], shoulderHeld = held.bones[fixture.bones[0].name];
        Vector3 heldArm = handHeld.position - shoulderHeld.position;

        foreach (NamedHead p in head.arm.poses ?? new NamedHead[0])
        {
            Rig r = Build(fixture, pose, twisted, HandholdGrip.ArmMode.Animation);
            r.grip.blendTime = 0f;
            bool found = r.grip.Show(p.name.ToUpperInvariant()) && r.grip.Showing == p.name;
            Call(r.grip, "LateUpdate");
            float off = (r.bones[handBone.name].position - handHeld.position).magnitude;
            float turned = Quaternion.Angle(r.bones[handBone.name].rotation, handHeld.rotation);
            bool same = p.name == "Held";
            Debug.Log(string.Format("HANDHOLD_CHECK {0}: pose '{1}' {2}: hand {3:F5} from the hold ({4:F2}% of span), turned {5:F2} deg from it{6}",
                label, p.name, found ? "shown" : "NOT FOUND", off, 100f * off / span, turned, same ? " (has to match it)" : ""));
            ok &= found && (!same || (off < 0.01f * span && turned < 1f));
            Destroy(r);
        }

        foreach (LookHead l in head.arm.looks ?? new LookHead[0])
        {
            Rig r = Build(fixture, pose, twisted, HandholdGrip.ArmMode.Animation);
            r.grip.blendTime = 0f;
            var camera = new GameObject("Aim").transform;
            r.grip.aimSource = camera;
            bool found = r.grip.Show(l.name);
            // the character's own up, front and right, in the world
            Quaternion frame = r.wrapper.rotation;
            Vector3 up = frame * Vector3.up;
            Vector3 front = frame * (head.arm.forward != null && head.arm.forward.Length == 3 ? Mirror(V(head.arm.forward)) : Vector3.forward);
            Vector3 right = Vector3.Cross(up, front).normalized;
            Transform hand = r.bones[handBone.name], shoulder = r.bones[fixture.bones[0].name];
            Func<float, float, Vector3> look = (yaw, pitch) =>
            {
                camera.rotation = Quaternion.LookRotation(Quaternion.AngleAxis(yaw, up) * Quaternion.AngleAxis(-pitch, right) * front, up);
                Call(r.grip, "LateUpdate");
                return hand.position;
            };
            bool centred = Mathf.Abs(l.yaw[0] + l.yaw[1]) < 0.01f && Mathf.Abs(l.pitch[0] + l.pitch[1]) < 0.01f;
            float ahead = (look(0f, 0f) - handHeld.position).magnitude;
            float upOff = (look(0f, l.pitch[1]) - (shoulder.position + Quaternion.AngleAxis(-l.pitch[1], right) * heldArm)).magnitude;
            float rightOff = (look(l.yaw[1], 0f) - (shoulder.position + Quaternion.AngleAxis(l.yaw[1], up) * heldArm)).magnitude;
            float downLeftOff = (look(l.yaw[0], l.pitch[0]) - (shoulder.position + Quaternion.AngleAxis(l.yaw[0], up) * (Quaternion.AngleAxis(-l.pitch[0], right) * heldArm))).magnitude;
            float past = (look(l.yaw[1] + 60f, 0f) - look(l.yaw[1], 0f)).magnitude;
            Debug.Log(string.Format("HANDHOLD_CHECK {0}: look '{1}' {2} (yaw {3}..{4}, pitch {5}..{6}): straight ahead the hand is {7:F5} from the hold ({8:F2}%{9}); fully up {10:F5} from the arc ({11:F2}%), fully right {12:F5} ({13:F2}%), down-left corner {14:F5} ({15:F2}%); looking past the range moves it {16:F5}",
                label, l.name, found ? "shown" : "NOT FOUND", l.yaw[0], l.yaw[1], l.pitch[0], l.pitch[1], ahead, 100f * ahead / span, centred ? "" : ", range not centred",
                upOff, 100f * upOff / span, rightOff, 100f * rightOff / span, downLeftOff, 100f * downLeftOff / span, past));
            ok &= found && ahead < (centred ? 0.01f : 0.05f) * span && upOff < 0.015f * span && rightOff < 0.015f * span && downLeftOff < 0.015f * span && past < 0.001f * span;
            Destroy(r);
            UnityEngine.Object.DestroyImmediate(camera.gameObject);
        }

        foreach (ClipHead c in head.arm.clips ?? new ClipHead[0])
        {
            Rig r = Build(fixture, pose, twisted, HandholdGrip.ArmMode.Animation);
            r.grip.blendTime = 0f;
            string finished = null;
            r.grip.Finished += n => finished = n;
            bool found = r.grip.Show(c.name) && r.grip.IsPlaying;
            Call(r.grip, "LateUpdate");
            Transform hand = r.bones[handBone.name];
            Vector3 start = hand.position;
            float travel = 0f;
            for (int k = 1; k <= 12 && found; k++)
            {
                r.grip.Seek(c.duration * k / 13f);
                Call(r.grip, "LateUpdate");
                travel = Mathf.Max(travel, (hand.position - start).magnitude);
            }
            r.grip.Seek(c.duration + 1f);
            Call(r.grip, "LateUpdate");
            bool ended = c.loops ? r.grip.IsPlaying && finished == null : !r.grip.IsPlaying && finished == c.name && r.grip.Showing == "";
            Debug.Log(string.Format("HANDHOLD_CHECK {0}: animation '{1}' {2}, {3:F2} s{4}: the hand travels {5:F4} ({6:F1}% of span); past its end it {7}",
                label, c.name, found ? "plays" : "NOT FOUND", c.duration, c.loops ? ", loops" : "", travel, 100f * travel / span,
                ended ? (c.loops ? "carries on round" : "stops and hands the arm back") : "DID THE WRONG THING"));
            ok &= found && travel > 0f && ended;
            Destroy(r);
        }
        return ok;
    }

    static bool IsParentOf(Fixture fixture, string name, string child)
    {
        foreach (FBone b in fixture.bones) if (b.name == child) return b.parent == name;
        return false;
    }
}
