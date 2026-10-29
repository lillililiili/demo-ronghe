import { makeFrame, project as projectMetres, unproject as unprojectMetres, heightFromDrag as dragMetres } from './airspaceVolume.js';

// Display-only exaggeration: geometry, form values and saved AMSL metres are untouched.
// The same factor is used by projection and its inverses, including a frozen drag frame.
// view {lon, lat, extent} optionally replaces the auto-fitted centre and range (frozen while
// drawing, panned, wheel-zoomed). Such a view is anchored on the floor (the lower plane, or sea
// level until the heights are valid), so the map and the points stay put while the boundary or
// the heights change; the exaggeration still follows the volume itself.
export function makeViewFrame(polygons, lower, upper, camera, enhanceHeight = true, view = null) {
  const frame = makeFrame(polygons, lower, upper);
  const ready = Number.isFinite(lower) && Number.isFinite(upper) && upper > lower;
  const pixels = ready ? (upper - lower) * frame.scale * camera.zoom * Math.cos(camera.pitch) : 0;
  const heightScale = enhanceHeight && pixels > 0 ? Math.max(1, 100 / pixels) : 1;
  if (!view) return { ...frame, heightScale };
  return { ...frame, lon: view.lon, lat: view.lat, mx: frame.my * Math.max(1e-6, Math.cos(view.lat * Math.PI / 180)),
    altitude: ready ? lower : 0, extent: view.extent, scale: 330 / view.extent, heightScale };
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
