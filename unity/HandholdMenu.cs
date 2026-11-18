// Handhold: one-click setup. Lives in an Editor folder.
//
// Select your character in the scene (and, if you like, Ctrl-click the prop
// it should hold), then choose Tools > Handhold > Add grip to selected character.
// The newest exported pose in the project is used.

#if UNITY_EDITOR
using System;
using System.IO;
using UnityEditor;
using UnityEngine;

public static class HandholdMenu
{
    const string Item = "Tools/Handhold/Add grip to selected character";

    [MenuItem(Item, true)]
    static bool CanAdd()
    {
        return Selection.activeGameObject != null;
    }

    [MenuItem(Item)]
    static void Add()
    {
        GameObject character = Selection.activeGameObject;
        if (!character) return;

        TextAsset pose = NewestPose();
        if (!pose)
        {
            EditorUtility.DisplayDialog("Handhold", "No exported pose (.pose.json) was found in this project. Import the package from Handhold first.", "OK");
            return;
        }

        HandholdGrip grip = character.GetComponent<HandholdGrip>();
        if (!grip) grip = Undo.AddComponent<HandholdGrip>(character);
        Undo.RecordObject(grip, "Handhold grip");
        grip.poseJson = pose;
        // anything else that is selected and is not part of the character is the prop to hold
        foreach (Transform t in Selection.transforms)
        {
            if (t == character.transform || t.IsChildOf(character.transform)) continue;
            grip.heldObject = t;
            break;
        }
        EditorUtility.SetDirty(grip);
        Debug.Log("Handhold: " + character.name + " now uses " + AssetDatabase.GetAssetPath(pose) + (grip.heldObject ? " and holds " + grip.heldObject.name : "") + ". Press Play to see it.", grip);
    }

    static TextAsset NewestPose()
    {
        TextAsset newest = null;
        DateTime newestTime = DateTime.MinValue;
        foreach (string guid in AssetDatabase.FindAssets("t:TextAsset"))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            if (!path.EndsWith(".pose.json", StringComparison.OrdinalIgnoreCase)) continue;
            DateTime time = File.GetLastWriteTimeUtc(path);
            if (newest && time <= newestTime) continue;
            TextAsset asset = AssetDatabase.LoadAssetAtPath<TextAsset>(path);
            if (!asset) continue;
            newest = asset;
            newestTime = time;
        }
        return newest;
    }
}
#endif
