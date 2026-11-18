// Handhold grip player for Unity.
//
// Applies a grip exported from Handhold to a character that is already in
// your project, with its own bones:
//
//   - turns the finger bones into the grip            (grip, 0..1)
//   - puts a prop in the hand at the right offset     (heldObject)
//   - places the arm                                  (armMode, Show)
//   - two-handed grips: puts the other hand on its own (secondHandWeight)
//     spot and bends that arm to reach it, wherever the first hand goes
//
// Saved poses, animations and looks
//   Everything saved on Handhold's Animations tab is in the file, by name:
//
//     grip.Show("Raised");      // a pose: the arm goes there and stays
//     grip.Show("Swing");       // an animation: plays once, then goes back
//     grip.Show("Walk");        // a looping animation: plays until told otherwise
//     grip.Show("Look");        // a look: the arm follows the camera, up, down, left and right
//     grip.Show(null);          // back to armMode
//
//   SavedNames lists what the file has. startWith shows one as soon as the
//   file is loaded. With armMode left at FromExport, a file that has a look
//   starts with it.
//
// Arm modes (what the arm does while nothing saved is shown)
//   Animation     Your animation (walk, run, idle) moves the arm. Only the
//                 fingers and the prop are added on top of it.
//   Hold          The arm stays at the exported hold position while the rest
//                 of the body animates. `sweep` (0..1) moves it along the
//                 exported sweep, if one was marked.
//   FollowCamera  The arm follows where `aimSource` (your camera) looks, up
//                 and down: along the exported sweep if there is one,
//                 otherwise by swinging the held pose at the shoulder.
//   FromExport    Whichever of the three was chosen when exporting.
//
// Quickest setup: select the character in the scene, then
// Tools > Handhold > Add grip to selected character.
//
// The character must be in its bind pose (T-pose or A-pose) when this
// component starts; that is the normal state before any animation has run.
// Rotations are applied in LateUpdate, after the Animator, so they layer on
// top of whatever animation is playing.
//
// Nothing here depends on how the model was imported. The exported file
// carries the rest position of every bone it names; at start those are lined
// up with the same bones in the scene, which gives the turn and the scale
// between the two, whatever axes or units the importer chose.

using System;
using System.Collections.Generic;
using UnityEngine;

public class HandholdGrip : MonoBehaviour
{
    public enum ArmMode { FromExport, Animation, Hold, FollowCamera }

    [Tooltip("The .pose.json exported from Handhold.")]
    public TextAsset poseJson;

    [Tooltip("Root of the character. Leave empty to use this object.")]
    public Transform characterRoot;

    [Tooltip("The prop to put in the hand. Optional.")]
    public Transform heldObject;

    [Tooltip("Extra turn for the prop, in degrees, if its model was imported with different axes.")]
    public Vector3 heldObjectTurn;

    [Range(0f, 1f)]
    [Tooltip("0 leaves the fingers to your animation, 1 is the full grip.")]
    public float grip = 1f;

    [Header("Arm")]
    [Tooltip("Animation: your animation moves the arm. Hold: the arm stays at the exported position. FollowCamera: the arm follows where the camera looks.")]
    public ArmMode armMode = ArmMode.FromExport;

    [Range(0f, 1f)]
    [Tooltip("How strongly the exported arm pose overrides the animation. Blend this to 0 to hand the arm back, for example while sprinting.")]
    public float armWeight = 1f;

    [Range(0f, 1f)]
    [Tooltip("Hold mode: position along the exported sweep (0 = start, 1 = end).")]
    public float sweep = 0f;

    [Header("Saved poses, animations and looks")]
    [Tooltip("Name of a saved pose, animation or look to show as soon as the file is loaded. Leave empty to start with the arm mode above.")]
    public string startWith = "";

    [Tooltip("Seconds the arm takes to move from one saved pose, animation or look to the next.")]
    public float blendTime = 0.15f;

    [Header("Follow camera")]
    [Tooltip("What the arm follows. Leave empty to use the main camera.")]
    public Transform aimSource;

    [Tooltip("Looking this far down (degrees) is the start of the sweep.")]
    public float aimDown = -60f;

    [Tooltip("Looking this far up (degrees) is the end of the sweep.")]
    public float aimUp = 60f;

    [Tooltip("Seconds the arm takes to catch up with the camera. 0 = instantly. Also used by saved looks.")]
    public float aimSmoothing = 0.08f;

    [Header("Second hand")]
    [Range(0f, 1f)]
    [Tooltip("Two-handed grips only: how firmly the second hand holds on. Blend to 0 to let go, for example while reloading.")]
    public float secondHandWeight = 1f;

    // filled in by JsonUtility, which the compiler cannot see
#pragma warning disable 0649
    [Serializable] class Trs { public float[] position; public float[] quaternion; public float[] scale; }
    [Serializable] class BonePose { public string name; public float[] delta; }
    [Serializable] class RestPoint { public string name; public float[] position; }
    [Serializable] class ArmHold { public float[] upperArm; public float[] forearm; public float[] hand; }
    [Serializable] class ArmKey { public float t; public float[] upperArm; public float[] forearm; public float[] hand; }
    [Serializable] class SavedPose { public string name; public float[] upperArm; public float[] forearm; public float[] hand; public ArmHold second; }
    [Serializable] class ClipFrame { public float t; public float away; public float[] upperArm; public float[] forearm; public float[] hand; public ArmHold second; }
    [Serializable] class SavedClip { public string name; public float duration; public bool loops; public ClipFrame[] frames; }
    [Serializable] class LookPoint { public float yaw; public float pitch; public float[] upperArm; public float[] forearm; public float[] hand; public ArmHold second; }
    [Serializable] class SavedLook { public string name; public float[] yaw; public float[] pitch; public int columns; public int rows; public LookPoint[] grid; }
    [Serializable] class ArmPose
    {
        public string mode; public string upperArm; public string forearm; public string hand;
        public float[] forward;
        public ArmHold hold; public ArmKey[] sweep;
        public SavedPose[] poses; public SavedClip[] clips; public SavedLook[] looks;
    }
    [Serializable] class Reach { public float[] position; public float[] delta; }
    [Serializable] class SecondHand { public string handBone; public BonePose[] bones; public Reach reach; public ArmPose arm; }
    [Serializable] class Pose
    {
        public string format; public int version; public string handBone;
        public Trs objectAtRest; public BonePose[] bones; public RestPoint[] restPoints; public ArmPose arm;
        public SecondHand secondHand;
    }
#pragma warning restore 0649

    Pose pose;
    Transform root, hand, upper, fore;
    Transform[] fingers = new Transform[0];
    Quaternion[] fingerInHand = new Quaternion[0];   // each finger bone's gripped rotation, relative to the hand bone
    Quaternion upperRest, foreRest, handRest;        // rest rotations in the character root's space
    readonly Dictionary<Transform, Quaternion> restRotation = new Dictionary<Transform, Quaternion>();
    readonly Dictionary<Transform, Vector3> restPosition = new Dictionary<Transform, Vector3>();
    Quaternion fit = Quaternion.identity;            // turns the exported model's space into the character root's space
    float unit = 1f;                                 // exported units -> character root units
    Vector3 exportedCentre, sceneCentre;
    float sweepNow, pitchNow, yawNow;
    bool ready;

    // One arm position: how far each arm bone has turned from rest, in the character root's space.
    struct ArmSample
    {
        public Quaternion upper, fore, hand, upper2, fore2;
        public bool second;      // upper2 and fore2 are set (two-handed grips)
        public float away;       // 0..1: how far the second hand has let go
    }

    // what is shown: nothing saved (armMode decides), or a saved pose, animation or look
    enum Kind { None, Pose, Clip, Look }
    Kind shown = Kind.None, back = Kind.None;   // `back` is what a one-shot animation returns to
    int shownIndex, backIndex, clipFrame;
    float clipTime, blend = 1f;
    ArmSample last, blendFrom;
    Vector3 front = Vector3.forward;            // the way the character faces, in the root's space
    Vector3 upright = Vector3.up;               // and the way it stands

    // second hand (two-handed grips)
    Transform hand2, upper2, fore2;
    Transform[] fingers2 = new Transform[0];
    Quaternion[] fingerInHand2 = new Quaternion[0];
    Quaternion hand2Rest, upper2Rest, fore2Rest;
    Vector3 reachPoint;                               // where the second hand bone sits while the first hand is at rest (root space)
    Quaternion reachTurn;                             // and its rotation then (root space)
    bool twoHands;

    /// <summary>True once a pose has been loaded and its bones were found.</summary>
    public bool IsReady { get { return ready; } }

    /// <summary>True when the loaded grip holds the object with both hands.</summary>
    public bool HasSecondHand { get { return ready && twoHands; } }

    /// <summary>The names of the saved poses, animations and looks in the loaded file.</summary>
    public string[] SavedNames
    {
        get
        {
            var names = new List<string>();
            ArmPose a = pose != null ? pose.arm : null;
            if (a == null) return names.ToArray();
            if (a.poses != null) foreach (SavedPose p in a.poses) names.Add(p.name);
            if (a.clips != null) foreach (SavedClip c in a.clips) if (Playable(c)) names.Add(c.name);
            if (a.looks != null) foreach (SavedLook l in a.looks) if (Usable(l)) names.Add(l.name);
            return names.ToArray();
        }
    }

    /// <summary>The name of the saved pose, animation or look the arm is showing now, or "" for none.</summary>
    public string Showing
    {
        get
        {
            if (!ready || pose.arm == null) return "";
            if (shown == Kind.Pose) return pose.arm.poses[shownIndex].name;
            if (shown == Kind.Clip) return pose.arm.clips[shownIndex].name;
            if (shown == Kind.Look) return pose.arm.looks[shownIndex].name;
            return "";
        }
    }

    /// <summary>True while a saved animation is playing.</summary>
    public bool IsPlaying { get { return ready && shown == Kind.Clip; } }

    /// <summary>Jumps to a time (seconds) in the saved animation that is playing. It carries on from there.</summary>
    public void Seek(float seconds)
    {
        if (IsPlaying) clipTime = Mathf.Max(0f, seconds);
    }

    /// <summary>Raised when a saved animation that does not loop reaches its end, with its name.</summary>
    public event Action<string> Finished;

    /// <summary>
    /// Shows a saved pose, animation or look by name (upper and lower case do not matter).
    /// A pose stays, an animation plays (once, or round and round if it loops) and a look
    /// follows the camera. Pass null or "" to hand the arm back to armMode.
    /// Returns false if the file has nothing by that name.
    /// </summary>
    public bool Show(string name)
    {
        if (!ready) { startWith = name ?? ""; return false; }
        if (string.IsNullOrEmpty(name)) { Begin(Kind.None, 0, Capture()); return true; }
        ArmPose a = pose.arm;
        if (a == null || !upper || !fore) return false;
        for (int i = 0; a.poses != null && i < a.poses.Length; i++)
            if (Same(a.poses[i].name, name)) { Begin(Kind.Pose, i, Capture()); return true; }
        for (int i = 0; a.clips != null && i < a.clips.Length; i++)
            if (Same(a.clips[i].name, name) && Playable(a.clips[i])) { Begin(Kind.Clip, i, Capture()); return true; }
        for (int i = 0; a.looks != null && i < a.looks.Length; i++)
            if (Same(a.looks[i].name, name) && Usable(a.looks[i])) { Begin(Kind.Look, i, Capture()); return true; }
        return false;
    }

    static bool Same(string a, string b) { return string.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
    static bool Has(float[] q) { return q != null && q.Length == 4; }
    static bool Playable(SavedClip c) { return c != null && c.frames != null && c.frames.Length >= 2; }
    static bool Usable(SavedLook l)
    {
        return l != null && l.grid != null && l.columns >= 1 && l.rows >= 1 && l.grid.Length >= l.columns * l.rows
            && l.yaw != null && l.yaw.Length == 2 && l.pitch != null && l.pitch.Length == 2;
    }

    void Begin(Kind kind, int index, ArmSample from)
    {
        if (kind == Kind.Clip)
        {
            // a one-shot animation goes back to whatever was shown before it
            if (shown != Kind.Clip) { back = shown; backIndex = shownIndex; }
            clipTime = 0f;
            clipFrame = 0;
        }
        blendFrom = from;
        blend = blendTime > 0f ? 0f : 1f;
        shown = kind;
        shownIndex = index;
    }

    // The arm as it is right now, as turns from rest: where a blend to something new starts.
    ArmSample Capture()
    {
        ArmSample s = last;
        if (!upper || !fore) return s;
        Quaternion toRoot = Quaternion.Inverse(root.rotation);
        s.upper = toRoot * upper.rotation * Quaternion.Inverse(upperRest);
        s.fore = toRoot * fore.rotation * Quaternion.Inverse(foreRest);
        s.hand = toRoot * hand.rotation * Quaternion.Inverse(handRest);
        s.second = twoHands && upper2 && fore2;
        if (s.second)
        {
            s.upper2 = toRoot * upper2.rotation * Quaternion.Inverse(upper2Rest);
            s.fore2 = toRoot * fore2.rotation * Quaternion.Inverse(fore2Rest);
        }
        return s;
    }

    // Handhold works in a right-handed space (glTF); Unity is left-handed. Mirroring X converts between them.
    static Quaternion Mirror(float[] q)
    {
        return (q == null || q.Length < 4) ? Quaternion.identity : new Quaternion(q[0], -q[1], -q[2], q[3]);
    }

    static Vector3 Mirror3(float[] p)
    {
        return (p == null || p.Length < 3) ? Vector3.zero : new Vector3(-p[0], p[1], p[2]);
    }

    /// <summary>An exported rotation, as a rotation in the character root's space.</summary>
    Quaternion Turn(float[] q) { return fit * Mirror(q) * Quaternion.Inverse(fit); }

    /// <summary>An exported point, as a point in the character root's space.</summary>
    Vector3 Point(float[] p) { return fit * ((Mirror3(p) - exportedCentre) * unit) + sceneCentre; }

    // Importers disagree about punctuation in bone names ("mixamorig:RightHand",
    // "mixamorig_RightHand", "mixamorigRightHand"), so a name that is not found
    // exactly is looked for again with only its letters and digits.
    static string Loose(string name)
    {
        var sb = new System.Text.StringBuilder(name.Length);
        foreach (char c in name)
            if (char.IsLetterOrDigit(c)) sb.Append(char.ToLowerInvariant(c));
        return sb.ToString();
    }

    static Transform FindExact(Transform t, string name)
    {
        if (t.name == name) return t;
        for (int i = 0; i < t.childCount; i++)
        {
            Transform found = FindExact(t.GetChild(i), name);
            if (found) return found;
        }
        return null;
    }

    static Transform FindLoose(Transform t, string loose)
    {
        if (Loose(t.name) == loose) return t;
        for (int i = 0; i < t.childCount; i++)
        {
            Transform found = FindLoose(t.GetChild(i), loose);
            if (found) return found;
        }
        return null;
    }

    static Transform Find(Transform t, string name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        Transform found = FindExact(t, name);
        return found ? found : FindLoose(t, Loose(name));
    }

    void Remember(Transform t)
    {
        restRotation[t] = Quaternion.Inverse(root.rotation) * t.rotation;
        restPosition[t] = root.InverseTransformPoint(t.position);
        for (int i = 0; i < t.childCount; i++) Remember(t.GetChild(i));
    }

    void Start()
    {
        root = characterRoot ? characterRoot : transform;
        // the whole character is still in its bind pose here: keep it, so other grips can be loaded later
        Remember(root);
        if (poseJson) Load(poseJson);
        else Debug.LogWarning("HandholdGrip: no pose JSON assigned.", this);
    }

    /// <summary>Switches to another exported grip. Can be called at any time after Start.</summary>
    public void Load(TextAsset json)
    {
        ready = false;
        poseJson = json;
        if (!root || !json) return;
        pose = JsonUtility.FromJson<Pose>(json.text);
        if (pose == null || pose.bones == null || string.IsNullOrEmpty(pose.handBone))
        {
            Debug.LogError("HandholdGrip: this file is not a Handhold pose.", this);
            return;
        }
        hand = Find(root, pose.handBone);
        if (!hand || !restRotation.ContainsKey(hand))
        {
            Debug.LogError("HandholdGrip: hand bone '" + pose.handBone + "' not found under " + root.name + ".", this);
            return;
        }
        LineUp();
        handRest = restRotation[hand];

        LoadFingers(pose.bones, handRest, out fingers, out fingerInHand);
        FindArm(pose.arm, out upper, out fore, out upperRest, out foreRest);

        // Second hand: its fingers, its arm, and where it holds on relative to the first hand
        twoHands = false;
        hand2 = upper2 = fore2 = null;
        fingers2 = new Transform[0];
        fingerInHand2 = new Quaternion[0];
        SecondHand sh = pose.secondHand;
        if (sh != null && !string.IsNullOrEmpty(sh.handBone))
        {
            hand2 = Find(root, sh.handBone);
            if (hand2 && restRotation.ContainsKey(hand2) && sh.reach != null && sh.reach.position != null && sh.reach.position.Length == 3)
            {
                hand2Rest = restRotation[hand2];
                LoadFingers(sh.bones, hand2Rest, out fingers2, out fingerInHand2);
                FindArm(sh.arm, out upper2, out fore2, out upper2Rest, out fore2Rest);
                reachPoint = Point(sh.reach.position);
                reachTurn = Turn(sh.reach.delta) * hand2Rest;
                twoHands = true;
            }
            else Debug.LogWarning("HandholdGrip: second hand bone '" + sh.handBone + "' not found; holding with one hand.", this);
        }
        sweepNow = sweep;
        pitchNow = yawNow = 0f;
        shown = back = Kind.None;
        blend = 1f;
        last = new ArmSample { upper = Quaternion.identity, fore = Quaternion.identity, hand = Quaternion.identity, upper2 = Quaternion.identity, fore2 = Quaternion.identity };
        front = Vector3.forward;
        upright = (fit * Vector3.up).normalized;
        if (pose.arm != null && pose.arm.forward != null && pose.arm.forward.Length == 3)
        {
            Vector3 facing = fit * Mirror3(pose.arm.forward);
            facing -= upright * Vector3.Dot(facing, upright);
            if (facing.sqrMagnitude > 1e-8f) front = facing.normalized;
        }
        else front = (fit * Vector3.forward).normalized;

        // Prop: where it sat in the model's space while the hand was at rest, re-expressed relative to the hand bone.
        if (heldObject && pose.objectAtRest != null && pose.objectAtRest.position != null && pose.objectAtRest.position.Length == 3)
        {
            Matrix4x4 handAtRest = Matrix4x4.TRS(restPosition[hand], handRest, Vector3.one);
            Quaternion objectTurn = fit * Mirror(pose.objectAtRest.quaternion) * Quaternion.Euler(heldObjectTurn);
            Matrix4x4 objectAtRest = Matrix4x4.TRS(Point(pose.objectAtRest.position), objectTurn, Vector3.one);
            Matrix4x4 inHand = handAtRest.inverse * objectAtRest;
            Vector3 offset = inHand.GetColumn(3);
            heldObject.SetParent(hand, true);
            heldObject.rotation = hand.rotation * inHand.rotation;
            heldObject.position = hand.position + hand.rotation * Vector3.Scale(offset, root.lossyScale);
        }
        ready = true;

        // start with what was asked for; failing that, a file with a look in it follows the camera
        float blendWas = blendTime;
        blendTime = 0f;
        if (!string.IsNullOrEmpty(startWith))
        {
            if (!Show(startWith)) Debug.LogWarning("HandholdGrip: nothing saved is called '" + startWith + "'. This file has: " + string.Join(", ", SavedNames) + ".", this);
        }
        else if (armMode == ArmMode.FromExport && Mode() == ArmMode.FollowCamera && pose.arm.looks != null && pose.arm.looks.Length > 0 && Usable(pose.arm.looks[0]))
            Show(pose.arm.looks[0].name);
        blendTime = blendWas;
    }

    // Fingers: the exported turn from rest, applied to this skeleton's own rest pose,
    // then stored relative to the hand so the grip follows the hand wherever the arm goes.
    void LoadFingers(BonePose[] list, Quaternion handRestTurn, out Transform[] found, out Quaternion[] inHand)
    {
        var bones = new List<Transform>();
        var rel = new List<Quaternion>();
        if (list != null)
        {
            foreach (BonePose b in list)
            {
                Transform t = Find(root, b.name);
                if (!t || !restRotation.ContainsKey(t))
                {
                    Debug.LogWarning("HandholdGrip: finger bone '" + b.name + "' not found; skipped.", this);
                    continue;
                }
                rel.Add(Quaternion.Inverse(handRestTurn) * (Turn(b.delta) * restRotation[t]));
                bones.Add(t);
            }
        }
        found = bones.ToArray();
        inHand = rel.ToArray();
    }

    void FindArm(ArmPose a, out Transform u, out Transform f, out Quaternion uRest, out Quaternion fRest)
    {
        u = f = null;
        uRest = fRest = Quaternion.identity;
        if (a == null || string.IsNullOrEmpty(a.upperArm)) return;
        u = Find(root, a.upperArm);
        f = Find(root, a.forearm);
        if (u && f && restRotation.ContainsKey(u) && restRotation.ContainsKey(f))
        {
            uRest = restRotation[u];
            fRest = restRotation[f];
        }
        else u = f = null;
    }

    // Finds the turn and scale that carry the exported rest skeleton onto the one in the scene.
    void LineUp()
    {
        fit = Quaternion.identity;
        unit = 1f;
        exportedCentre = sceneCentre = Vector3.zero;
        var a = new List<Vector3>();
        var b = new List<Vector3>();
        if (pose.restPoints != null)
        {
            foreach (RestPoint p in pose.restPoints)
            {
                Transform t = Find(root, p.name);
                if (!t || !restPosition.ContainsKey(t) || p.position == null || p.position.Length < 3) continue;
                a.Add(Mirror3(p.position));
                b.Add(restPosition[t]);
            }
        }
        if (a.Count < 3)
        {
            Debug.LogWarning("HandholdGrip: too few bones to line the export up with this character; assuming the same axes and units.", this);
            return;
        }
        Vector3 ca = Vector3.zero, cb = Vector3.zero;
        for (int i = 0; i < a.Count; i++) { ca += a[i]; cb += b[i]; }
        ca /= a.Count; cb /= b.Count;
        double spreadA = 0, spreadB = 0;
        var s = new double[3, 3];
        for (int i = 0; i < a.Count; i++)
        {
            Vector3 p = a[i] - ca, q = b[i] - cb;
            spreadA += p.sqrMagnitude; spreadB += q.sqrMagnitude;
            for (int r = 0; r < 3; r++)
                for (int c = 0; c < 3; c++)
                    s[r, c] += (double)p[r] * q[c];
        }
        if (spreadA < 1e-12 || spreadB < 1e-12) return;
        exportedCentre = ca;
        sceneCentre = cb;
        unit = (float)Math.Sqrt(spreadB / spreadA);
        fit = BestRotation(s);
    }

    // Horn's closed-form answer to "which rotation best carries one set of points onto another":
    // the quaternion is the leading eigenvector of a 4x4 matrix built from the points' cross-covariance.
    static Quaternion BestRotation(double[,] s)
    {
        double sxx = s[0, 0], sxy = s[0, 1], sxz = s[0, 2];
        double syx = s[1, 0], syy = s[1, 1], syz = s[1, 2];
        double szx = s[2, 0], szy = s[2, 1], szz = s[2, 2];
        var n = new double[4, 4]
        {
            { sxx + syy + szz, syz - szy,        szx - sxz,        sxy - syx },
            { syz - szy,       sxx - syy - szz,  sxy + syx,        szx + sxz },
            { szx - sxz,       sxy + syx,       -sxx + syy - szz,  syz + szy },
            { sxy - syx,       szx + sxz,        syz + szy,       -sxx - syy + szz },
        };
        // shift so every eigenvalue is positive, then square the matrix repeatedly:
        // what survives is the leading eigenvector, in every column
        double norm = 0;
        for (int r = 0; r < 4; r++) for (int c = 0; c < 4; c++) norm += n[r, c] * n[r, c];
        norm = Math.Sqrt(norm);
        if (norm < 1e-30) return Quaternion.identity;
        for (int i = 0; i < 4; i++) n[i, i] += norm;
        for (int pass = 0; pass < 24; pass++)
        {
            var m = new double[4, 4];
            double biggest = 0;
            for (int r = 0; r < 4; r++)
                for (int c = 0; c < 4; c++)
                {
                    double v = 0;
                    for (int k = 0; k < 4; k++) v += n[r, k] * n[k, c];
                    m[r, c] = v;
                    biggest = Math.Max(biggest, Math.Abs(v));
                }
            for (int r = 0; r < 4; r++) for (int c = 0; c < 4; c++) n[r, c] = m[r, c] / biggest;
        }
        int best = 0;
        double bestLength = -1;
        for (int c = 0; c < 4; c++)
        {
            double length = 0;
            for (int r = 0; r < 4; r++) length += n[r, c] * n[r, c];
            if (length > bestLength) { bestLength = length; best = c; }
        }
        double inv = 1.0 / Math.Sqrt(bestLength);
        // rows are (w, x, y, z)
        return new Quaternion((float)(n[1, best] * inv), (float)(n[2, best] * inv), (float)(n[3, best] * inv), (float)(n[0, best] * inv));
    }

    ArmMode Mode()
    {
        if (armMode != ArmMode.FromExport) return armMode;
        if (pose == null || pose.arm == null) return ArmMode.Animation;
        if (pose.arm.mode == "hold") return ArmMode.Hold;
        if (pose.arm.mode == "camera") return ArmMode.FollowCamera;
        return ArmMode.Animation;
    }

    void SampleArm(ArmPose a, float t, out Quaternion u, out Quaternion f, out Quaternion h)
    {
        if (a.sweep != null && a.sweep.Length >= 2)
        {
            t = Mathf.Clamp01(t);
            int i = 0;
            while (i < a.sweep.Length - 2 && a.sweep[i + 1].t < t) i++;
            ArmKey k0 = a.sweep[i], k1 = a.sweep[i + 1];
            float s = Mathf.InverseLerp(k0.t, k1.t, t);
            u = Quaternion.Slerp(Turn(k0.upperArm), Turn(k1.upperArm), s);
            f = Quaternion.Slerp(Turn(k0.forearm), Turn(k1.forearm), s);
            h = Quaternion.Slerp(Turn(k0.hand), Turn(k1.hand), s);
            return;
        }
        u = Turn(a.hold != null ? a.hold.upperArm : null);
        f = Turn(a.hold != null ? a.hold.forearm : null);
        h = Turn(a.hold != null ? a.hold.hand : null);
    }

    // Bends the elbow so the hand is as far from the shoulder as the target, then swings the
    // upper arm so the hand lands on it. Keeps the elbow on the side it already bends to.
    static void ReachFor(Transform upper, Transform fore, Transform hand, Vector3 target, Vector3 bendHint)
    {
        Vector3 a = upper.position, b = fore.position, c = hand.position;
        float lab = (b - a).magnitude, lbc = (c - b).magnitude;
        if (lab < 1e-6f || lbc < 1e-6f) return;
        float lat = Mathf.Clamp((target - a).magnitude, Mathf.Abs(lab - lbc) + 1e-4f, lab + lbc - 1e-4f);
        Vector3 n = Vector3.Cross(a - b, c - b);
        if (n.sqrMagnitude < 1e-6f * lab * lab * lbc * lbc) n = Vector3.Cross(a - b, bendHint);   // straight arm: bend the elbow back
        if (n.sqrMagnitude < 1e-12f) return;
        n.Normalize();
        float now = Vector3.Angle(a - b, c - b);
        float want = Mathf.Acos(Mathf.Clamp((lab * lab + lbc * lbc - lat * lat) / (2f * lab * lbc), -1f, 1f)) * Mathf.Rad2Deg;
        fore.rotation = Quaternion.AngleAxis(want - now, n) * fore.rotation;
        upper.rotation = Quaternion.FromToRotation(hand.position - a, target - a) * upper.rotation;
    }

    ArmSample Sample(float[] u, float[] f, float[] h, ArmHold second, float away)
    {
        ArmSample s = new ArmSample();
        s.upper = Turn(u);
        s.fore = Turn(f);
        s.hand = Turn(h);
        s.second = second != null && Has(second.upperArm) && Has(second.forearm);
        s.upper2 = s.second ? Turn(second.upperArm) : Quaternion.identity;
        s.fore2 = s.second ? Turn(second.forearm) : Quaternion.identity;
        s.away = away;
        return s;
    }

    static ArmSample Mix(ArmSample a, ArmSample b, float t)
    {
        ArmSample s = new ArmSample();
        s.upper = Quaternion.Slerp(a.upper, b.upper, t);
        s.fore = Quaternion.Slerp(a.fore, b.fore, t);
        s.hand = Quaternion.Slerp(a.hand, b.hand, t);
        s.second = a.second || b.second;
        s.upper2 = a.second && b.second ? Quaternion.Slerp(a.upper2, b.upper2, t) : (b.second ? b.upper2 : a.upper2);
        s.fore2 = a.second && b.second ? Quaternion.Slerp(a.fore2, b.fore2, t) : (b.second ? b.fore2 : a.fore2);
        s.away = Mathf.Lerp(a.away, b.away, t);
        return s;
    }

    ArmSample SampleClip(SavedClip c, float time)
    {
        ClipFrame[] frames = c.frames;
        int i = Mathf.Clamp(clipFrame, 0, frames.Length - 2);
        while (i < frames.Length - 2 && frames[i + 1].t <= time) i++;
        while (i > 0 && frames[i].t > time) i--;
        clipFrame = i;
        ClipFrame k0 = frames[i], k1 = frames[i + 1];
        float s = Mathf.InverseLerp(k0.t, k1.t, time);
        return Mix(Sample(k0.upperArm, k0.forearm, k0.hand, k0.second, k0.away), Sample(k1.upperArm, k1.forearm, k1.hand, k1.second, k1.away), s);
    }

    // Which two rows (or columns) of a look's grid a value falls between, and how far along.
    static void Between(float from, float to, float value, int count, out int i0, out int i1, out float t)
    {
        i0 = i1 = 0;
        t = 0f;
        if (count < 2) return;
        float at = Mathf.InverseLerp(from, to, value) * (count - 1);
        i0 = Mathf.Min((int)at, count - 2);
        i1 = i0 + 1;
        t = at - i0;
    }

    // A look is a grid of arm positions over the view's yaw (left to right) and pitch (down to up).
    ArmSample SampleLook(SavedLook l, float yaw, float pitch)
    {
        int c0, c1, r0, r1;
        float tx, ty;
        Between(l.yaw[0], l.yaw[1], yaw, l.columns, out c0, out c1, out tx);
        Between(l.pitch[0], l.pitch[1], pitch, l.rows, out r0, out r1, out ty);
        LookPoint a = l.grid[r0 * l.columns + c0], b = l.grid[r0 * l.columns + c1];
        LookPoint c = l.grid[r1 * l.columns + c0], d = l.grid[r1 * l.columns + c1];
        ArmSample low = Mix(Sample(a.upperArm, a.forearm, a.hand, a.second, 0f), Sample(b.upperArm, b.forearm, b.hand, b.second, 0f), tx);
        ArmSample high = Mix(Sample(c.upperArm, c.forearm, c.hand, c.second, 0f), Sample(d.upperArm, d.forearm, d.hand, d.second, 0f), tx);
        return Mix(low, high, ty);
    }

    // Where the camera looks: pitch above the plane that `up` stands on, yaw to the right of `facing`
    // (all in the root's space). `across` is the camera's right, laid flat on that plane.
    void ReadAim(Vector3 up, Vector3 facing, out Vector3 across)
    {
        Transform aim = aimSource ? aimSource : (Camera.main ? Camera.main.transform : null);
        float yaw = 0f, pitch = 0f;
        across = Vector3.right;
        if (aim)
        {
            Vector3 look = root.InverseTransformDirection(aim.forward);
            float rise = Vector3.Dot(look, up);
            Vector3 flat = look - up * rise;
            pitch = Mathf.Atan2(rise, flat.magnitude) * Mathf.Rad2Deg;
            if (flat.sqrMagnitude > 1e-8f) yaw = Vector3.SignedAngle(facing, flat, up);
            across = root.InverseTransformDirection(aim.right);
            across -= up * Vector3.Dot(across, up);
            across = across.sqrMagnitude > 1e-8f ? across.normalized : Vector3.right;
        }
        float follow = aimSmoothing > 0f ? 1f - Mathf.Exp(-Time.deltaTime / aimSmoothing) : 1f;
        pitchNow = Mathf.Lerp(pitchNow, pitch, follow);
        yawNow = Mathf.LerpAngle(yawNow, yaw, follow);
    }

    // The arm position that armMode asks for when nothing saved is shown.
    ArmSample FromMode(ArmMode mode)
    {
        Quaternion swing = Quaternion.identity;
        bool hasSweep = pose.arm.sweep != null && pose.arm.sweep.Length >= 2;
        if (mode == ArmMode.FollowCamera)
        {
            Vector3 across;
            ReadAim(Vector3.up, Vector3.forward, out across);
            float pitch = Mathf.Clamp(pitchNow, Mathf.Min(aimDown, aimUp), Mathf.Max(aimDown, aimUp));
            if (hasSweep) sweepNow = Mathf.InverseLerp(aimDown, aimUp, pitch);
            else swing = Quaternion.AngleAxis(-pitch, across);   // no sweep was marked: swing the held pose at the shoulder
        }
        else sweepNow = sweep;

        ArmSample s = new ArmSample();
        Quaternion u, f, h;
        SampleArm(pose.arm, sweepNow, out u, out f, out h);
        s.upper = swing * u;
        s.fore = swing * f;
        s.hand = swing * h;
        s.upper2 = s.fore2 = Quaternion.identity;
        ArmPose a2 = twoHands ? pose.secondHand.arm : null;
        if (a2 != null && a2.hold != null && Has(a2.hold.upperArm))
        {
            SampleArm(a2, sweepNow, out u, out f, out h);
            s.upper2 = swing * u;
            s.fore2 = swing * f;
            s.second = true;
        }
        return s;
    }

    // The arm position to aim for this frame.
    ArmSample Target(ArmMode mode)
    {
        ArmPose a = pose.arm;
        if (shown == Kind.Pose)
        {
            SavedPose p = a.poses[shownIndex];
            return Sample(p.upperArm, p.forearm, p.hand, p.second, 0f);
        }
        if (shown == Kind.Clip)
        {
            SavedClip c = a.clips[shownIndex];
            float length = c.frames[c.frames.Length - 1].t;
            clipTime += Time.deltaTime;
            if (clipTime < length) return SampleClip(c, clipTime);
            if (c.loops && length > 0f)
            {
                clipTime %= length;
                return SampleClip(c, clipTime);
            }
            // a one-shot has finished: hold its last frame now, and blend back from it
            ArmSample end = SampleClip(c, length);
            Begin(back, backIndex, end);
            if (Finished != null) Finished(c.name);
            return end;
        }
        if (shown == Kind.Look)
        {
            // a look is measured from the way the character itself stands and faces
            Vector3 across;
            ReadAim(upright, front, out across);
            return SampleLook(a.looks[shownIndex], yawNow, pitchNow);
        }
        return FromMode(mode);
    }

    void LateUpdate()
    {
        if (!ready) return;
        ArmMode mode = Mode();
        bool armPlaced = false;
        float weight = armWeight;
        ArmSample s = last;
        if (upper && fore && pose.arm != null && armWeight > 0f)
        {
            // the arm is ours while something saved is shown, or while armMode places it
            bool ours = shown != Kind.None || mode != ArmMode.Animation;
            bool blending = blend < 1f;
            if (ours) s = Target(mode);
            if (blending)
            {
                blend = blendTime > 0f ? Mathf.Min(1f, blend + Time.deltaTime / blendTime) : 1f;
                float k = blend * blend * (3f - 2f * blend);
                if (ours) s = Mix(blendFrom, s, k);
                else { s = blendFrom; weight *= 1f - k; }   // handing the arm back to your animation
            }
            if (ours || blending)
            {
                Quaternion r = root.rotation;
                upper.rotation = Quaternion.Slerp(upper.rotation, r * s.upper * upperRest, weight);
                fore.rotation = Quaternion.Slerp(fore.rotation, r * s.fore * foreRest, weight);
                hand.rotation = Quaternion.Slerp(hand.rotation, r * s.hand * handRest, weight);
                armPlaced = true;
                last = s;
            }
        }
        float holdOn = secondHandWeight * (armPlaced ? 1f - Mathf.Clamp01(s.away) : 1f);
        if (twoHands && holdOn > 0f) PlaceSecondHand(armPlaced, s, weight, holdOn);
        if (grip <= 0f) return;
        for (int i = 0; i < fingers.Length; i++)
            fingers[i].rotation = Quaternion.Slerp(fingers[i].rotation, hand.rotation * fingerInHand[i], grip);
        for (int i = 0; i < fingers2.Length; i++)
            fingers2[i].rotation = Quaternion.Slerp(fingers2[i].rotation, hand2.rotation * fingerInHand2[i], grip * holdOn);
    }

    // Where the second hand bone belongs now: wherever the first hand has carried the object.
    void SecondHandGoal(out Vector3 goal, out Quaternion goalTurn)
    {
        Quaternion r = root.rotation;
        // the first hand's turn from rest, in the root's space
        Quaternion carry = Quaternion.Inverse(r) * hand.rotation * Quaternion.Inverse(handRest);
        Vector3 firstNow = root.InverseTransformPoint(hand.position);
        goal = root.TransformPoint(firstNow + carry * (reachPoint - restPosition[hand]));
        goalTurn = r * carry * reachTurn;
    }

    // The exported arm pose gives the elbow a natural start, and a reach closes whatever gap is left.
    void PlaceSecondHand(bool armPlaced, ArmSample s, float weight, float w)
    {
        if (upper2 && fore2 && armPlaced && s.second)
        {
            Quaternion r = root.rotation;
            upper2.rotation = Quaternion.Slerp(upper2.rotation, r * s.upper2 * upper2Rest, weight * w);
            fore2.rotation = Quaternion.Slerp(fore2.rotation, r * s.fore2 * fore2Rest, weight * w);
        }
        Vector3 goal;
        Quaternion goalTurn;
        SecondHandGoal(out goal, out goalTurn);
        if (upper2 && fore2) ReachFor(upper2, fore2, hand2, Vector3.Lerp(hand2.position, goal, w), root.forward);
        hand2.rotation = Quaternion.Slerp(hand2.rotation, goalTurn, w);
    }

    /// <summary>Where the second hand bone belongs right now (world space), carried along by the first hand.
    /// Aim your own IK here if you would rather use it; set secondHandWeight to 0 then.</summary>
    public Vector3 SecondHandSpot()
    {
        if (!HasSecondHand) return Vector3.zero;
        Vector3 goal;
        Quaternion goalTurn;
        SecondHandGoal(out goal, out goalTurn);
        return goal;
    }

    /// <summary>How far (in world units) the second hand is from its spot on the object. 0 when it reaches.</summary>
    public float SecondHandGap()
    {
        if (!HasSecondHand) return 0f;
        Vector3 goal;
        Quaternion goalTurn;
        SecondHandGoal(out goal, out goalTurn);
        return Vector3.Distance(hand2.position, goal);
    }
}
