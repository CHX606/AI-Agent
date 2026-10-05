import { InteractionController, type InteractionCallbacks } from "./interaction/controller";
import "./interaction-view.css";

export function createInteractionView(callbacks: InteractionCallbacks) {
  return new InteractionController(callbacks);
}
