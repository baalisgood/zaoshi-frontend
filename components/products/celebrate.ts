"use client";
// 支付成功礼花：纯 Canvas，无第三方依赖；约 1.8 秒后自动移除，尊重“减少动态效果”。
const COLORS=["#3156f5","#5b7cfa","#8ea6ff","#c7d2fe","#f5b428","#ffd88a","#e9d5a1"];
type Piece={x:number;y:number;vx:number;vy:number;rot:number;vr:number;w:number;h:number;color:string;shape:0|1|2;tilt:number};
export function celebrate(){
 if(typeof window==="undefined"||typeof document==="undefined")return;
 if(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)return;
 const canvas=document.createElement("canvas");const ctx=canvas.getContext("2d");if(!ctx)return;
 const dpr=Math.min(window.devicePixelRatio||1,2),W=window.innerWidth,H=window.innerHeight;
 canvas.width=W*dpr;canvas.height=H*dpr;canvas.className="zs-confetti";canvas.setAttribute("aria-hidden","true");
 Object.assign(canvas.style,{position:"fixed",inset:"0",width:`${W}px`,height:`${H}px`,pointerEvents:"none",zIndex:"1000"});
 document.body.appendChild(canvas);ctx.scale(dpr,dpr);
 const pieces:Piece[]=[];const burst=(ox:number,oy:number,count:number,spread:number,angle:number)=>{for(let i=0;i<count;i++){const a=angle+(Math.random()-.5)*spread,speed=6+Math.random()*9;pieces.push({x:ox,y:oy,vx:Math.cos(a)*speed,vy:Math.sin(a)*speed,rot:Math.random()*Math.PI,vr:(Math.random()-.5)*.3,w:7+Math.random()*7,h:3+Math.random()*2,color:COLORS[Math.floor(Math.random()*COLORS.length)],shape:(Math.random()<.6?0:Math.random()<.7?1:2) as 0|1|2,tilt:Math.random()*Math.PI});}};
 burst(W/2,H*.42,90,Math.PI*2,0);burst(0,H*.7,40,Math.PI/3,-Math.PI/3);burst(W,H*.7,40,Math.PI/3,-Math.PI*2/3);
 const start=performance.now(),life=1800;
 const frame=(t:number)=>{const p=(t-start)/life;ctx.clearRect(0,0,W,H);if(p>=1){canvas.remove();return;}
  ctx.globalAlpha=p<.7?1:1-(p-.7)/.3;
  for(const c of pieces){c.vx*=.985;c.vy=c.vy*.985+.28;c.x+=c.vx;c.y+=c.vy;c.rot+=c.vr;c.tilt+=.12;ctx.save();ctx.translate(c.x,c.y);ctx.rotate(c.rot);ctx.fillStyle=c.color;
   if(c.shape===0)ctx.fillRect(-c.w/2,-c.h/2*Math.abs(Math.cos(c.tilt))-.5,c.w,c.h*Math.abs(Math.cos(c.tilt))+1);
   else if(c.shape===1){ctx.beginPath();ctx.arc(0,0,c.h*.8,0,Math.PI*2);ctx.fill();}
   else{ctx.beginPath();ctx.moveTo(0,-c.h*1.4);ctx.lineTo(c.h*1.2,c.h);ctx.lineTo(-c.h*1.2,c.h);ctx.closePath();ctx.fill();}
   ctx.restore();}
  requestAnimationFrame(frame);};
 requestAnimationFrame(frame);
}
