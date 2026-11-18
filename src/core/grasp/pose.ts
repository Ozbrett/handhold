import { Vector3 } from 'three';
import { type HandModel, poseMatrices } from '../hand/model';
import type { Grasp } from './solver';

/** Collision spheres of the hand in object space for a finished grip (for display and checks). */
export function graspSpheres(
  model: HandModel,
  grasp: Pick<Grasp, 'wrist' | 'angles'>,
): { center: Vector3; radius: number; finger: number; link: number }[] {
  const mats = poseMatrices(model, grasp.angles);
  return model.spheres.map((s) => ({
    center: s.center.clone().applyMatrix4(mats[s.joint]).applyMatrix4(grasp.wrist),
    radius: s.radius,
    finger: s.finger,
    link: s.link,
  }));
}
