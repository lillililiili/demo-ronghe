const valid = p => Array.isArray(p) && p.length>=2 && p.slice(0,2).every(Number.isFinite) && Math.abs(p[0])<=180 && Math.abs(p[1])<=85.051129;
export function riskContextCoordinates(context) {
  if (!context) return [];
  return [...(context.points || []).filter(p=>p.basis!=='CURRENT_MEAS').map(p=>[p.lon,p.lat]),
    ...(context.airspaces || []).flatMap(a=>(a.rings || []).flat()),
    ...(context.flightPlans || []).flatMap(plan=>plan.coordinates || []),
    ...(context.lines || []).flatMap(line=>line.coordinates || []),
    ...(context.polygons || []).flatMap(area=>area.coordinates || [])].filter(valid);
}
/** Geometry is from selected event evidence; live targets remain owned by the fusion layer. */
export function drawRiskEvidenceGeometry(map, context) {
  if (!context || !map?.ctx) return;
  const c=map.ctx, styles=getComputedStyle(document.documentElement);
  const color=styles.getPropertyValue('--amber').trim() || '#e8b04c';
  const bg=styles.getPropertyValue('--surface-1').trim() || '#08152c';
  function label(text,p) {
    if (!text || p[0]<0 || p[1]<0 || p[0]>map.w || p[1]>map.h) return;
    c.font='11px sans-serif'; const shown=String(text).slice(0,34),width=c.measureText(shown).width+10;
    const x=Math.min(map.w-width-4,Math.max(4,p[0]+8)),y=Math.min(map.h-20,Math.max(22,p[1]-12));
    c.fillStyle=bg;c.fillRect(x,y-13,width,20);c.fillStyle=color;c.fillText(shown,x+5,y+1);
  }
  c.save();c.lineWidth=2;c.strokeStyle=color;
  for(const shape of [...(context.polygons || []).map(row=>({...row,polygon:true})),...(context.lines || [])]) {
    if(!shape.coordinates?.length || !shape.coordinates.every(valid))continue;
    const pixels=shape.coordinates.map(p=>map.px(...p));
    c.beginPath();pixels.forEach((p,index)=>index?c.lineTo(...p):c.moveTo(...p));
    c.setLineDash(shape.polygon?[5,4]:[]);
    if(shape.polygon){c.closePath();c.globalAlpha=.1;c.fillStyle=color;c.fill();c.globalAlpha=1;}
    c.stroke();label(shape.label,pixels[0]);
  }
  c.setLineDash([]);
  for(const point of context.points || []) {
    if(point.basis==='CURRENT_MEAS' || !valid([point.lon,point.lat]))continue;
    const p=map.px(point.lon,point.lat);c.beginPath();c.arc(...p,5,0,Math.PI*2);c.fillStyle=bg;c.fill();c.stroke();label(point.label,p);
  }
  c.restore();
}
