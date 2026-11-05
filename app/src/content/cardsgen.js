/* eslint-disable */
// kula's night card: 400×600, front and back, as an svg string (components/NightCard.tsx
// draws it with SvgXml). The metals and motifs are the user's own design from an earlier
// card sketch; 5.11.2026 the words became kula's (model, project, devices, tokens, credits,
// energy) and the sample nights that came with the sketch went.

const CARDS = (function () {

// ─────────── METAL THEMES ───────────
const METALS = {
  steel:{name:'brushed steel',
    grad:['#3e4147','#8d939b','#4a4e55','#b9bfc7','#5a5f67','#d8dde3','#666b73','#a7adb5','#41454b','#9ba1a9','#787e86'],
    edge:['#e8edf2','#6a6f77','#dfe4ea','#585d64','#c2c8cf'],
    plate:['#22252a','#171a1e','#2b2f35','#15181c'],
    deep:'#0a0b0d', poster:'#141619', dim:'#5c6169', mid:'#8e949c',
    hi:'#d8dde3', txt:'#f0ece3', sub:'#7b8189', faint:'#4e535a', line:'#3a3e44', accent:'#c9ced5', hair:'#ffffff', hairO:.04},
  gold:{name:'gold',
    grad:['#6b4c13','#d9b45c','#7a5a1c','#f3dc9a','#8a6522','#ffeec2','#96702a','#e6c876','#6f5217','#d4b160','#b99447'],
    edge:['#ffeec2','#8a6522','#f3dc9a','#6f5217','#dcbb6b'],
    plate:['#241a08','#161005','#2b2009','#130e04'],
    deep:'#0d0903', poster:'#171105', dim:'#7a5a1c', mid:'#b8913c',
    hi:'#ffeec2', txt:'#f7e9c4', sub:'#96702a', faint:'#6f5217', line:'#4a3712', accent:'#f3dc9a', hair:'#ffd98a', hairO:.05},
  chrome:{name:'chrome',
    grad:['#7d8894','#ffffff','#5f6a76','#eef3f8','#46505b','#ffffff','#6d7883','#dde4eb','#3d4650','#f5f9fc','#c3ccd5'],
    edge:['#ffffff','#5f6a76','#eef3f8','#46505b','#c3ccd5'],
    plate:['#dfe5eb','#f7fafc','#c4cdd6','#aeb8c2'],
    deep:'#8a949e', poster:'#1a1e23', dim:'#535d68', mid:'#9aa5b0',
    hi:'#2f3740', txt:'#232a31', sub:'#59636d', faint:'#98a2ac', line:'#a8b2bc', accent:'#46505b', hair:'#5c6670', hairO:.11, light:1},
  copper:{name:'oxidised copper',
    grad:['#5a2f1c','#c9784b','#6b3a22','#e8a274','#7d4527','#f7c9a4','#8a4d2b','#d68d5e','#603322','#bd7047','#8f5030'],
    edge:['#f7c9a4','#7d4527','#4a9c8a','#6b3a22','#d68d5e'],
    plate:['#241309','#150c06','#1c2a26','#120a04'],
    deep:'#0d0703', poster:'#1a0f07', dim:'#6b3a22', mid:'#a86039',
    hi:'#f7c9a4', txt:'#f2d3b4', sub:'#8a5a3c', faint:'#6b3a22', line:'#4a2a18', accent:'#4a9c8a', hair:'#e8a274', hairO:.05, patina:1},
  gunmetal:{name:'gunmetal',
    grad:['#242830','#5c6474','#2e333d','#7d8598','#383e49','#9aa2b4','#434a57','#6e7688','#282d36','#5a6272','#4a515e'],
    edge:['#9aa2b4','#383e49','#8990a2','#2e333d','#6e7688'],
    plate:['#181b21','#101318','#1e222a','#0d1014'],
    deep:'#080a0d', poster:'#111419', dim:'#3a404b', mid:'#5c6474',
    hi:'#9aa2b4', txt:'#c8cdd8', sub:'#5f6674', faint:'#383e49', line:'#2a2f38', accent:'#8a92a4', hair:'#aab2c4', hairO:.035},
  brass:{name:'brass',
    grad:['#5e4a17','#c4a648','#6d5620','#e3cb7e','#7b6226','#f5e3a8','#876e2c','#d4bb62','#5f4c1a','#bda653','#96803a'],
    edge:['#f5e3a8','#7b6226','#e3cb7e','#5f4c1a','#c9b25c'],
    plate:['#201a0a','#141006','#26200c','#110d05'],
    deep:'#0c0904', poster:'#161206', dim:'#6d5620', mid:'#a68d3c',
    hi:'#f5e3a8', txt:'#ece0b8', sub:'#876e2c', faint:'#5f4c1a', line:'#403316', accent:'#e3cb7e', hair:'#e3cb7e', hairO:.045},
  rose:{name:'rose gold',
    grad:['#6b3a34','#d99a8c','#7d4640','#f2c2b4','#8a524a','#ffd9cc','#96605a','#e6ab9c','#6f423c','#d4948a','#b97f74'],
    edge:['#ffd9cc','#8a524a','#f2c2b4','#6f423c','#dca79c'],
    plate:['#241413','#16100f','#2b1a18','#130d0c'],
    deep:'#0d0706', poster:'#170f0e', dim:'#7d4640', mid:'#b8776c',
    hi:'#ffd9cc', txt:'#f5ded6', sub:'#96605a', faint:'#6f423c', line:'#4a2b28', accent:'#f2c2b4', hair:'#ffb8a8', hairO:.05},
  titanium:{name:'titanium',
    grad:['#2a3644','#6a8299','#33414f','#8ea6bd','#3d4d5d','#aec6dd','#48596b','#7d94aa','#2e3a48','#688096','#54697d'],
    edge:['#aec6dd','#3d4d5d','#8ea6bd','#2e3a48','#7d94aa'],
    plate:['#151d26','#0e141b','#1b242e','#0b1015'],
    deep:'#070b0f', poster:'#101720', dim:'#3a4a5a', mid:'#5f7688',
    hi:'#aec6dd', txt:'#cfdde9', sub:'#5f7688', faint:'#3d4d5d', line:'#28333f', accent:'#8ea6bd', hair:'#b8d4ea', hairO:.04},
  nickel:{name:'nickel',
    grad:['#2f3a34','#748a7e','#3a463f','#96ab9e','#45524a','#b6cabd','#505e55','#84998c','#33403a','#6f8478','#5c6a62'],
    edge:['#b6cabd','#45524a','#96ab9e','#33403a','#84998c'],
    plate:['#1a211d','#121814','#212a24','#0f1411'],
    deep:'#090d0b', poster:'#131a16', dim:'#3d4a43', mid:'#65786c',
    hi:'#b6cabd', txt:'#d4e0d8', sub:'#65786c', faint:'#45524a', line:'#2b352f', accent:'#96ab9e', hair:'#a8c4b4', hairO:.04},
  anthracite:{name:'anthracite',
    grad:['#1c1c1e','#4e4e52','#232326','#6c6c72','#2a2a2e','#88888f','#333338','#5c5c62','#1f1f22','#4a4a4f','#3c3c41'],
    edge:['#88888f','#2a2a2e','#6c6c72','#1f1f22','#5c5c62'],
    plate:['#151517','#0e0e10','#1b1b1e','#0b0b0d'],
    deep:'#060607', poster:'#111113', dim:'#2e2e32', mid:'#4e4e52',
    hi:'#88888f', txt:'#b8b8bf', sub:'#5a5a60', faint:'#333338', line:'#252529', accent:'#9a9aa2', hair:'#c8c8d0', hairO:.03}
};

// ─────────── POSTER MOTIFS ───────────
// each takes (id, m) and uses the metal palette
const MOTIFS = {
  rays:(id,m)=>{let s=`<g transform="translate(200,140)">`;
    const A=[[-170,-52,-170,-12],[-158,40,-134,78],[-86,118,-46,142],[12,170,52,160],[114,98,142,66],[170,18,168,-24],[130,-96,106,-128],[32,-170,-8,-172]];
    A.forEach(p=>s+=`<path d="M0,0 L${p[0]},${p[1]} L${p[2]},${p[3]} Z" fill="${m.dim}"/>`);
    const B=[[-144,60,-114,96],[34,166,72,146],[170,-4,158,-44]];
    B.forEach(p=>s+=`<path d="M0,0 L${p[0]},${p[1]} L${p[2]},${p[3]} Z" fill="${m.mid}"/>`);
    s+=`<circle r="96" fill="none" stroke="url(#e${id})" stroke-width="2.5"/><circle r="78" fill="none" stroke="url(#e${id})" stroke-width="2.5"/>`;
    s+=`<circle r="68" fill="${m.deep}"/><path d="M-46 0 Q0 -38 46 0 Q0 38 -46 0 Z" fill="url(#g${id})"/>`;
    s+=`<circle r="19" fill="${m.poster}"/><circle r="8" fill="${m.hi}"/></g>`;return s;},

  oval:(id,m)=>`<ellipse cx="200" cy="142" rx="74" ry="94" fill="url(#g${id})"/>
    <ellipse cx="200" cy="142" rx="52" ry="70" fill="${m.poster}"/>
    <path d="M200 82 L214 130 L262 142 L214 154 L200 202 L186 154 L138 142 L186 130 Z" fill="url(#g${id})"/>
    <circle cx="200" cy="142" r="9" fill="${m.hi}"/>
    <path d="M156 196 Q200 224 244 196" fill="none" stroke="${m.mid}" stroke-width="2.5"/>`,

  diagonal:(id,m)=>`<path d="M0 0 L400 0 L0 300 Z" fill="${m.dim}"/>
    <g stroke="url(#e${id})" stroke-width="2"><path d="M0 130 L400 130"/><path d="M0 146 L400 146"/><path d="M0 162 L400 162"/></g>
    <circle cx="200" cy="146" r="44" fill="${m.poster}" stroke="url(#e${id})" stroke-width="2.5"/>
    <text x="200" y="156" text-anchor="middle" font-family="InterTight_400Regular" font-weight="700" font-size="25" fill="url(#g${id})">10</text>`,

  orbit:(id,m)=>`<g fill="none" stroke="${m.mid}" stroke-width="2">
      <ellipse cx="200" cy="146" rx="150" ry="56"/>
      <ellipse cx="200" cy="146" rx="150" ry="56" transform="rotate(38 200 146)"/>
      <ellipse cx="200" cy="146" rx="150" ry="56" transform="rotate(-38 200 146)"/></g>
    <g fill="none" stroke="${m.dim}" stroke-width="1.5">
      <ellipse cx="200" cy="146" rx="112" ry="40" transform="rotate(76 200 146)"/></g>
    <circle cx="200" cy="146" r="52" fill="url(#g${id})"/>
    <circle cx="200" cy="146" r="52" fill="none" stroke="url(#e${id})" stroke-width="3"/>
    <g fill="${m.hi}"><circle cx="348" cy="92" r="5"/><circle cx="56" cy="212" r="4"/><circle cx="300" cy="240" r="3.5"/></g>`,

  grid:(id,m)=>{let s='',x,y,i=0;
    const cells=[[36,30],[148,30],[260,30],[36,116],[148,116],[260,116],[36,202],[148,202],[260,202]];
    cells.forEach((c,k)=>{
      const fill = k%3===0?m.dim:(k%3===1?m.poster:m.mid);
      s+=`<rect x="${c[0]}" y="${c[1]}" width="104" height="72" fill="${fill}" stroke="url(#e${id})" stroke-width="1.6"/>`;
      if(k%3===0) s+=`<circle cx="${c[0]+52}" cy="${c[1]+36}" r="22" fill="${m.poster}"/>`;
      if(k%3===1) s+=`<rect x="${c[0]+32}" y="${c[1]+16}" width="40" height="40" fill="url(#g${id})"/>`;
      if(k%3===2) s+=`<path d="M${c[0]+26} ${c[1]+54} L${c[0]+78} ${c[1]+54} L${c[0]+78} ${c[1]+16} Z" fill="${m.poster}"/>`;
    });return s;},

  moon:(id,m)=>{let s='';
    const ys=[74,150,226];
    ys.forEach((y,r)=>{
      const op=[1,.6,.3][r];
      s+=`<g opacity="${op}">
        <circle cx="66" cy="${y}" r="24" fill="none" stroke="${m.mid}" stroke-width="2.2"/>
        <path d="M148 ${y-24} A24 24 0 0 1 148 ${y+24} Z" fill="url(#g${id})"/>
        <circle cx="148" cy="${y}" r="24" fill="none" stroke="${m.mid}" stroke-width="2.2"/>
        <circle cx="230" cy="${y}" r="24" fill="url(#g${id})"/>
        <path d="M312 ${y-24} A24 24 0 0 0 312 ${y+24} Z" fill="url(#g${id})"/>
        <circle cx="312" cy="${y}" r="24" fill="none" stroke="${m.mid}" stroke-width="2.2"/></g>`;});
    return s;},

  moire:(id,m)=>{let s=`<g fill="none" stroke="${m.mid}" stroke-width="1.8">`;
    for(let r=14;r<=180;r+=17) s+=`<circle cx="180" cy="146" r="${r}"/>`;
    s+=`</g><g fill="none" stroke="${m.hi}" stroke-width="1.3" opacity="0.85">`;
    for(let r=14;r<=150;r+=17) s+=`<circle cx="228" cy="168" r="${r}"/>`;
    s+=`</g><path d="M212 76 L166 178 L200 178 L182 268 L246 152 L206 152 L240 76 Z" fill="url(#g${id})"/>`;
    return s;},

  bands:(id,m)=>{let s='';
    const c=[m.dim,m.mid,m.hi,m.mid,m.dim,m.faint];
    c.forEach((col,i)=>s+=`<rect y="${28+i*42}" width="400" height="42" fill="${col}" opacity="${.5+i*.06}"/>`);
    s+=`<circle cx="200" cy="146" r="76" fill="${m.poster}"/>
        <circle cx="200" cy="146" r="76" fill="none" stroke="url(#e${id})" stroke-width="3"/>
        <path d="M200 70 A76 76 0 0 1 200 222 Z" fill="url(#g${id})"/>`;
    return s;},

  iso:(id,m)=>`<path d="M132 82 L200 44 L268 82 L268 214 L200 252 L132 214 Z" fill="${m.dim}"/>
    <path d="M132 82 L200 120 L200 252 L132 214 Z" fill="${m.poster}"/>
    <path d="M200 120 L268 82 L268 214 L200 252 Z" fill="${m.mid}"/>
    <path d="M132 82 L200 44 L268 82 L200 120 Z" fill="url(#g${id})"/>
    <path d="M52 152 L88 132 L124 152 L124 216 L88 236 L52 216 Z" fill="${m.dim}"/>
    <path d="M52 152 L88 172 L88 236 L52 216 Z" fill="${m.poster}"/>
    <path d="M276 158 L312 138 L348 158 L348 216 L312 236 L276 216 Z" fill="${m.dim}"/>
    <path d="M312 178 L348 158 L348 216 L312 236 Z" fill="${m.mid}"/>`,

  descend:(id,m)=>`<path d="M0 40 L400 40 L400 300 L0 300 Z" fill="${m.dim}"/>
    <path d="M40 76 L360 76 L360 300 L40 300 Z" fill="${m.poster}"/>
    <path d="M80 118 L320 118 L320 300 L80 300 Z" fill="${m.deep}"/>
    <path d="M124 166 L276 166 L276 300 L124 300 Z" fill="${m.deep}"/>
    <g stroke="url(#e${id})" stroke-width="2.5" fill="none">
      <path d="M0 40 L400 40"/><path d="M40 76 L360 76"/><path d="M80 118 L320 118"/><path d="M124 166 L276 166"/></g>
    <g stroke="url(#e${id})" stroke-width="3" stroke-linecap="round" fill="none">
      <path d="M200 196 L200 250"/><path d="M178 230 L200 252 L222 230"/></g>`
};

// ─────────── DEFS ───────────
function defs(id,m){
  const gs=m.grad.map((c,i)=>`<stop offset="${Math.round(i*100/(m.grad.length-1))}%" stop-color="${c}"/>`).join('');
  const es=m.edge.map((c,i)=>`<stop offset="${Math.round(i*100/(m.edge.length-1))}%" stop-color="${c}"/>`).join('');
  const ps=m.plate.map((c,i)=>`<stop offset="${[0,40,72,100][i]}%" stop-color="${c}"/>`).join('');
  return `<defs>
    <linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="0.3">${gs}</linearGradient>
    <linearGradient id="e${id}" x1="0" y1="0" x2="1" y2="1">${es}</linearGradient>
    <linearGradient id="p${id}" x1="0" y1="0" x2="0.6" y2="1">${ps}</linearGradient>
    <clipPath id="c${id}"><rect x="0" y="0" width="400" height="300"/></clipPath>
  </defs>`;
}
function hairlines(m,ys){return `<g stroke="${m.hair}" stroke-width="0.5" opacity="${m.hairO}">`+
  ys.map(y=>`<line x1="0" y1="${y}" x2="400" y2="${y}"/>`).join('')+`</g>`;}
function rule(m,y){return `<line x1="34" y1="${y}" x2="366" y2="${y}" stroke="${m.deep}" stroke-width="1.5"/>
  <line x1="34" y1="${y+1.5}" x2="366" y2="${y+1.5}" stroke="${m.faint}" stroke-width="1"/>`;}

const WAVE=[26,42,62,30,78,50,22,70,38,86,54,26,74,46,94,58,30,82,50,22,70,42,90,62,30,78,50,22,66,38,82,54,26,70,42,18,50];
function wave(id,m,x0,yc){return `<g fill="url(#g${id})">`+WAVE.map((h,i)=>
  `<rect x="${x0+i*9}" y="${yc-h/2}" width="4" height="${h}"/>`).join('')+`</g>`;}

// ─────────── THE FRONT ───────────
// Every piece of night data goes through esc() on its way into the SVG
// string: the callers hand the result to innerHTML, so a title carrying
// a < or & must arrive as text, never as markup.
const esc=(v)=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function front(e,i){
  const m=METALS[e.metal]||METALS.steel, id='f'+i;
  /* A card that has not been earned yet is the same plate with the night
     missing from it. Nothing is hidden and nothing is blurred: the slots
     are all drawn, they are simply empty, which is the whole argument —
     you are looking at what the room fills in for you. */
  const av=e.blank?[0,1,2,3].map(k=>
    `<rect x="${34+k*54}" y="442" width="44" height="44" fill="none" stroke="${m.faint}" stroke-width="1.2" stroke-dasharray="4 4"/>`).join('')
   :e.crew.map((c,k)=>
    `<rect x="${34+k*54}" y="442" width="44" height="44" fill="${m.light?'#2f3740':m.poster}" stroke="${m.mid}" stroke-width="1"/>
     <text x="${56+k*54}" y="472" text-anchor="middle" font-family="InterTight_400Regular" font-size="17" fill="${m.light?'#eef3f8':m.hi}">${esc(c)}</text>`).join('')
   +`<rect x="${34+e.crew.length*54}" y="442" width="44" height="44" fill="none" stroke="${m.faint}" stroke-width="1.2" stroke-dasharray="4 4"/>
     <text x="${56+e.crew.length*54}" y="471" text-anchor="middle" font-family="InterTight_400Regular" font-size="15" fill="${m.sub}">+${esc(e.more)}</text>`;
  return `<svg viewBox="0 0 400 600">${defs(id,m)}
  <rect width="400" height="600" fill="url(#p${id})"/>
  ${hairlines(m,[322,332,344,358,376,398,424,454,490,530,572])}
  ${m.patina?`<g fill="#3f7d6f" opacity="0.13"><path d="M0 400 C 60 380, 90 430, 150 410 C 200 394, 230 440, 280 424 L 400 440 L 400 600 L 0 600 Z"/></g>`:''}
  <g clip-path="url(#c${id})">
    <rect width="400" height="300" fill="${m.poster}"/>
    ${(MOTIFS[e.motif]||MOTIFS.rays)(id,m)}
    <path d="M-40 0 L110 0 L30 300 L-120 300 Z" fill="#fff" opacity="0.05"/>
  </g>
  <line x1="0" y1="300" x2="400" y2="300" stroke="${m.deep}" stroke-width="2"/>
  <line x1="0" y1="302" x2="400" y2="302" stroke="${m.mid}" stroke-width="1"/>

  <text x="34" y="52" font-family="InterTight_400Regular" font-size="11" letter-spacing="3" fill="${m.mid}">${esc(e.ty)}</text>
  <text x="366" y="52" text-anchor="end" font-family="InterTight_400Regular" font-size="11" letter-spacing="3" fill="${e.blank?m.faint:(m.light?m.hi:m.accent)}">${e.blank?'ON ITS WAY':esc(e.froze)}</text>

  <text x="34" y="348" font-family="InterTight_500Medium" font-size="${e.t.length>26?19:(e.t.length>16?26:(e.t.length>12?31:37))}" letter-spacing="-1.4" fill="url(#g${id})">${esc(e.t.toUpperCase())}</text>
  <text x="34" y="372" font-family="InterTight_400Regular" font-size="10.5" letter-spacing="2" fill="${m.sub}">${[e.d,e.v,e.blank?'':e.in].filter(Boolean).map(esc).join(' · ')}</text>

  ${rule(m,398)}
  <text x="34" y="424" font-family="InterTight_400Regular" font-size="10" letter-spacing="3" fill="${m.sub}">WORKED ON IT</text>
  ${av}
  ${rule(m,514)}
  <g font-family="InterTight_400Regular" font-size="10.5" letter-spacing="1.6">
    <text x="34" y="540" fill="${m.sub}">TOKENS</text><text x="34" y="558" fill="${e.blank?m.faint:m.hi}">${e.blank?'—':esc(e.aud)}</text>
    <text x="140" y="540" fill="${m.sub}">CREDITS</text><text x="140" y="558" fill="${e.blank?m.faint:m.hi}">${e.blank?'—':esc(e.msg)}</text>
    <text x="260" y="540" fill="${m.sub}">ENERGY</text><text x="260" y="558" fill="${e.blank?m.faint:m.hi}">${e.blank?'—':esc(e.who)}</text>
  </g>
  <rect x="7" y="7" width="386" height="586" fill="none" stroke="url(#e${id})" stroke-width="4"/>
  <rect x="13" y="13" width="374" height="574" fill="none" stroke="${m.deep}" stroke-width="1"/>
</svg>`;}

// ─────────── THE BACK ───────────
function back(e,i){
  const m=METALS[e.metal]||METALS.steel, id='b'+i;
  /* A card still on its way (the night's end is in the outbox): the same four marks, none
     of them struck. A timeline with nothing on it yet is still a timeline. */
  const marks=e.blank
    ?[['—:—','STARTED',m.faint,0],
      ['—','TOKENS',m.faint,0],
      ['—','CREDITS',m.faint,0],
      ['—:—','ENDED',m.faint,0]]
    :[[e.in,'STARTED · '+(e.crew.length+e.more)+' WITH IT',m.hi,1],
      [e.aud,'TOKENS',m.accent,1],
      [String(e.msg),'CREDITS',m.mid,1],
      [e.out,'ENDED',m.sub,0]];
  const tl=marks.map((k,n)=>{
    const y=106+n*56;
    return (k[3]?`<rect x="42" y="${y}" width="12" height="12" fill="${k[2]}"/>`
                :`<rect x="42" y="${y}" width="12" height="12" fill="none" stroke="${m.mid}" stroke-width="1.5"/>`)
      +`<text x="74" y="${y+10}" font-size="12" fill="${k[2]}">${esc(k[0])}</text>`
      +`<text x="150" y="${y+10}" font-size="10" fill="${m.sub}">${esc(k[1])}</text>`;}).join('');
  return `<svg viewBox="0 0 400 600">${defs(id,m)}
  <rect width="400" height="600" fill="url(#p${id})"/>
  ${hairlines(m,[70,96,128,168,214,266,324,388,458,534])}
  ${m.patina?`<g fill="#4a9c8a" opacity="0.07"><path d="M0 470 C 60 458, 96 492, 156 478 C 210 466, 250 500, 300 488 L 400 498 L 400 600 L 0 600 Z"/></g>`:''}
  <path d="M-40 0 L90 0 L10 600 L-120 600 Z" fill="#fff" opacity="0.026"/>

  <text x="34" y="52" font-family="InterTight_400Regular" font-size="11" letter-spacing="3" fill="${m.mid}">THE NIGHT</text>
  <text x="366" y="52" text-anchor="end" font-family="InterTight_400Regular" font-size="11" letter-spacing="3" fill="${e.blank?m.faint:(m.light?m.hi:m.accent)}">${e.blank?'—H —M':esc(e.dur)}</text>
  ${rule(m,70)}

  <line x1="48" y1="104" x2="48" y2="286" stroke="${m.line}" stroke-width="1.5"/>
  <g font-family="InterTight_400Regular" letter-spacing="1.4">${tl}</g>

  ${rule(m,318)}
  <text x="34" y="344" font-family="InterTight_400Regular" font-size="10" letter-spacing="3" fill="${m.sub}">THE NIGHT'S WORK</text>
  ${e.blank?`<g opacity="0.16">${wave(id,m,34,387)}</g>`:wave(id,m,34,387)}
  ${e.blank
    ?`<g transform="translate(34,444)"><rect width="34" height="34" fill="none" stroke="${m.faint}" stroke-width="1.2" stroke-dasharray="4 4"/><path d="M19 7 L11 18 L16 18 L14 27 L23 15 L18 15 Z" fill="${m.faint}"/></g>`
    :`<g transform="translate(34,444)"><rect width="34" height="34" fill="url(#g${id})"/><path d="M19 7 L11 18 L16 18 L14 27 L23 15 L18 15 Z" fill="${m.poster}"/></g>`}
  <text x="80" y="466" font-family="InterTight_400Regular" font-size="10.5" letter-spacing="1.6" fill="${m.sub}">${e.blank?'ON CHARGE · NOT COUNTED YET':esc(e.who)+' · '+esc(e.dur)}</text>

  ${rule(m,498)}
  <g font-family="InterTight_400Regular" font-size="11">${e.blank
    ?`<text x="34" y="524" letter-spacing="1.6" font-size="10" fill="${m.faint}">THE MODEL · THE PROJECT</text>
      <line x1="34" y1="546" x2="366" y2="546" stroke="${m.faint}" stroke-width="1" stroke-dasharray="4 5" opacity="0.7"/>`
    :`<text x="34" y="524" letter-spacing="1.6" font-size="10" fill="${m.sub}">THE MODEL</text><text x="366" y="524" text-anchor="end" fill="${m.light?m.accent:m.txt}">${esc(e.ty)}</text>
      <text x="34" y="548" letter-spacing="1.6" font-size="10" fill="${m.sub}">FOR</text><text x="366" y="548" text-anchor="end" fill="${m.light?m.accent:m.txt}">${esc(e.v)}</text>`}
  </g>
  <text x="34" y="578" font-family="InterTight_400Regular" font-size="9.5" letter-spacing="2" fill="${m.faint}">${e.blank?'ON ITS WAY · NO. NOT ISSUED':esc(e.froze)+' · KULA · NO. '+esc(e.no)}</text>

  <rect x="7" y="7" width="386" height="586" fill="none" stroke="url(#e${id})" stroke-width="4"/>
  <rect x="13" y="13" width="374" height="574" fill="none" stroke="${m.deep}" stroke-width="1"/>
</svg>`;}

  return { front, back };
})();

export default CARDS;
