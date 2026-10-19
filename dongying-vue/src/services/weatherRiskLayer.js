import { weatherPolygon, insideWeather } from '@/services/weatherRiskGeometry.js';
export { weatherPolygon, insideWeather };

const COLORS = { wind: '#80bfd6', storm: '#56b8cd', visibility: '#a5bad0', multi: '#65bdcc', unknown: '#89b8ce' };
export const weatherLayerKind = reason => ({ WEATHER_STRONG_WIND: 'wind', WEATHER_THUNDERSTORM: 'storm', WEATHER_LOW_VISIBILITY: 'visibility', WEATHER_MULTI: 'multi' }[reason] || 'unknown');
export const weatherLayerGradient = kind => COLORS[kind] || COLORS.unknown;

function polygonPath(ctx, pixels) {
  ctx.beginPath();
  pixels.forEach(([x,y],i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
  ctx.closePath();
}

const mix = (a,b,t) => a+(b-a)*t;
const smooth = t => t*t*(3-2*t);
function noise(x,y) {
  const ix=Math.floor(x),iy=Math.floor(y),fx=smooth(x-ix),fy=smooth(y-iy);
  const hash=(a,b)=>{ const n=Math.sin(a*127.1+b*311.7+41.3)*43758.5453; return n-Math.floor(n); };
  return mix(mix(hash(ix,iy),hash(ix+1,iy),fx),mix(hash(ix,iy+1),hash(ix+1,iy+1),fx),fy);
}
function cloudNoise(x,y) {
  return .52*noise(x,y)+.27*noise(x*2.1+17,y*2.1+9)+.14*noise(x*4.3,y*4.3)+.07*noise(x*8.7,y*8.7);
}

// A fixed illustrative cloud material, not a meteorological grid or an intensity estimate.
// The source polygon and numeric observations remain the only geographic/weather facts.
export function weatherTexturePixels(size=256) {
  const pixels=new Uint8ClampedArray(size*size*4);
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const u=x/size*6,v=y/size*6;
    const n=cloudNoise(u+1.8*noise(u*.7,v*.7),v+1.2*noise(u*.7+8,v*.7));
    const density=Math.max(0,Math.min(1,(n-.28)/.48));
    const highlight=smooth(Math.max(0,Math.min(1,(n-.45)/.22)));
    const at=(y*size+x)*4;
    pixels[at]=mix(76,218,highlight); pixels[at+1]=mix(157,232,highlight); pixels[at+2]=mix(187,240,highlight);
    pixels[at+3]=Math.min(230,Math.round(density*density*230));
  }
  return pixels;
}
let texture;
function cloudTexture() {
  if (texture) return texture;
  const size=256;
  const canvas=typeof OffscreenCanvas==='function' ? new OffscreenCanvas(size,size) : document.createElement('canvas');
  canvas.width=size;canvas.height=size;
  const c=canvas.getContext('2d');
  const data=c.createImageData(size,size);data.data.set(weatherTexturePixels(size));c.putImageData(data,0,0);
  texture=canvas; return texture;
}

export function drawWeatherArea(ctx, map, fact, ring, route, color, kind, simulated, boundaryVisible, opacity = .18, layers = {}) {
  const clouds=layers.clouds!==false,windEnabled=layers.wind!==false;
  if ((!clouds && !windEnabled) || !weatherPolygon({ polygon: ring })) return;
  const pixels = ring.map(p => map.px(...p));
  const strength = Number.isFinite(opacity) ? Math.max(.08, Math.min(.32, opacity)) : .18;
  const tint = COLORS[kind] || COLORS.unknown;
  const left=Math.min(...pixels.map(p=>p[0])),top=Math.min(...pixels.map(p=>p[1]));
  const width=Math.max(...pixels.map(p=>p[0]))-left,height=Math.max(...pixels.map(p=>p[1]))-top;
  if(left>map.w || top>map.h || left+width<0 || top+height<0)return;
  const rain = Number.isFinite(fact?.precipitation_rate_mm_h) ? fact.precipitation_rate_mm_h>0 : /雨|雷暴/.test(fact?.summary || '') || kind==='storm';
  const cloudy = rain || /云|阴|雾/.test(fact?.summary || '') || kind==='visibility';
  const wind = windEnabled && Number.isFinite(fact?.wind_from_degrees) && Number.isFinite(fact?.wind_speed_mps) && fact.wind_speed_mps>0;
  ctx.save();
  polygonPath(ctx, pixels);
  ctx.clip();
  // Keep roads visible: only a very light footprint beneath the cloud material.
  ctx.fillStyle = tint; ctx.globalAlpha = strength*.22; ctx.fill();
  if(clouds && cloudy) {
    ctx.globalAlpha=Math.min(.48,strength*1.65);
    ctx.drawImage(cloudTexture(),left,top,width,height);
  }
  ctx.globalAlpha = boundaryVisible ? .55 : .28;
  ctx.strokeStyle = tint; ctx.lineWidth = 1; ctx.setLineDash([5,4]); ctx.stroke(); ctx.setLineDash([]);
  const xs=ring.map(p=>p[0]), ys=ring.map(p=>p[1]);
  const west=Math.min(...xs),east=Math.max(...xs),south=Math.min(...ys),north=Math.max(...ys);
  const angle=((fact?.wind_from_degrees || 0)+180)*Math.PI/180;
  const dx=Math.sin(angle),dy=-Math.cos(angle);
  const cols=Math.max(2,Math.min(18,Math.floor(width/48))), rows=Math.max(2,Math.min(16,Math.floor(height/48)));
  ctx.lineWidth=.85; ctx.lineCap='round';
  for(let i=0;i<cols;i++) for(let j=0;j<rows;j++) {
    const point=[west+(i+.5)*(east-west)/cols,south+(j+.5)*(north-south)/rows];
    if(!insideWeather(point,ring))continue;
    const [x,y]=map.px(...point);
    if(x < -100 || y < -100 || x > map.w+100 || y > map.h+100)continue;
    if(clouds && rain && (i+j)%3===0) {
      ctx.strokeStyle='#8ed4e4';ctx.globalAlpha=Math.min(.42,strength*1.8);
      ctx.beginPath();ctx.moveTo(x-8,y-4);ctx.lineTo(x-11,y+3);ctx.moveTo(x-1,y-4);ctx.lineTo(x-4,y+3);ctx.stroke();
    }
    if(wind) {
      const length=34+((i+2*j)%3)*9,ex=x+dx*length*.5,ey=y+dy*length*.5;
      ctx.strokeStyle='#b2d4df';ctx.globalAlpha=Math.min(.43,strength*1.65);
      ctx.beginPath();ctx.moveTo(x-dx*length*.5,y-dy*length*.5);
      // Collinear control point: no invented local change in wind direction.
      ctx.quadraticCurveTo(x,y,ex,ey);
      ctx.moveTo(ex-dx*5-dy*3,ey-dy*5+dx*3);ctx.lineTo(ex,ey);ctx.lineTo(ex-dx*5+dy*3,ey-dy*5-dx*3);ctx.stroke();
    }
  }
  ctx.restore();
}
