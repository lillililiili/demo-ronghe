import { makeFrame, project as projectMetres, unproject as unprojectMetres, heightFromDrag as dragMetres } from './airspaceVolume.js';

// Display-only exaggeration: geometry, form values and saved AMSL metres are untouched.
// The same factor is used by projection and its inverses, including a frozen drag frame.
export function makeViewFrame(polygons, lower, upper, camera, enhanceHeight = true) {
  const frame = makeFrame(polygons, lower, upper);
  const ready = Number.isFinite(lower) && Number.isFinite(upper) && upper > lower;
  const pixels = ready ? (upper - lower) * frame.scale * camera.zoom * Math.cos(camera.pitch) : 0;
  const heightScale = enhanceHeight && pixels > 0 ? Math.max(1, 100 / pixels) : 1;
  return { ...frame, heightScale };
}

const displayAltitude = (altitude, frame) => frame.altitude + (altitude - frame.altitude) * frame.heightScale;

export function project(point, altitude, frame, camera) {
  return projectMetres(point, displayAltitude(altitude, frame), frame, camera);
}

export function unproject(screen, altitude, frame, camera) {
  return unprojectMetres(screen, displayAltitude(altitude, frame), frame, camera);
}

export function heightFromDrag(altitude, screenDeltaY, frame, camera) {
  return dragMetres(altitude, screenDeltaY / frame.heightScale, frame, camera);
}
