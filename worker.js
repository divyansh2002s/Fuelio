import { solveFuelPlan } from "./optimizer.js";
self.onmessage = ({ data }) => {
  try {
    self.postMessage({ id: data.id, result: solveFuelPlan(data.input) });
  } catch (e) {
    self.postMessage({ id: data.id, error: e.message });
  }
};
