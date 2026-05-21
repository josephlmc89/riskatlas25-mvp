let lastGeo=null, lastFema=null, snapshot={}, stories=1;

function setStories(n){
  stories=n;
  document.getElementById("btn1").classList.toggle("active",n===1);
  document.getElementById("btn2").classList.toggle("active",n===2);
  if(lastGeo) calculateAndRender(lastGeo,lastFema);
}
function setStatus(msg){document.getElementById("status").textContent=msg;}
function val(id){return +document.getElementById(id).value;}
function sval(id){return document.getElementById(id).value;}
function cls(score){
  if(score<26)return["Critical Vulnerability","crit"];
  if(score<51)return["High Vulnerability","bad"];
  if(score<76)return["Moderate Vulnerability","warn"];
  return["Resilient Condition","good"];
}
function level(score){ if(score<26)return"Critical"; if(score<51)return"High"; if(score<76)return"Moderate"; return"Low"; }
function colorByLevel(l){return l==="Critical"?"#ff3b30":l==="High"?"#ff6b6b":l==="Moderate"?"#ffc857":"#38d878";}
function pillClass(l){return l==="Critical"?"crit":l==="High"?"bad":l==="Moderate"?"warn":"good";}
function exposurePenalty(exp){
  if(exp==="B") return 0;
  if(exp==="C") return 10;
  if(exp==="D") return 20;
  return 10;
}
function zonePenalty(z){
  if(z==="1") return 0;
  if(z==="2") return 8;
  if(z==="3") return 14;
  return 0;
}

function roofEnvelopeAdjustment(type){
  if(type==="metal") return 4;
  if(type==="tile") return -9;
  return 0;
}
function roofEnvelopeLabel(type){
  if(type==="metal") return "Metal Roof";
  if(type==="tile") return "Tile Roof";
  return "Asphalt Shingles";
}

function normalizeBFE(attr){
  if(!attr) return {value:null, unit:"", datum:"", display:"Not returned"};
  const candidates = ["STATIC_BFE","BFE","BASE_FLOOD_ELEVATION","ELEV","FLD_ELEV","DEPTH"];
  let value = null;
  let field = null;
  for(const k of candidates){
    if(attr[k] !== undefined && attr[k] !== null && attr[k] !== "" && attr[k] !== -9999){
      value = attr[k]; field = k; break;
    }
  }
  const unit = attr.LEN_UNIT || attr.UNITS || attr.ELEV_UNIT || attr.UNIT || "ft";
  const datum = attr.V_DATUM || attr.DATUM || attr.VERT_DATUM || "NAVD88 / verify";
  if(value === null) return {value:null, unit, datum, field:null, display:"Not returned"};
  const n = Number(value);
  const clean = isNaN(n) ? String(value) : (Math.round(n * 10) / 10).toString();
  return {value:clean, unit, datum, field, display:`${clean} ${unit}`};
}

function floodScore(zone,sfha,elev){
  let base=55;
  if(zone){
    zone=String(zone).toUpperCase();
    if(zone.includes("VE")||zone==="V")base=12;
    else if(zone.includes("AE")||zone==="A"||zone.includes("AO")||zone.includes("AH"))base=25;
    else if(zone.includes("X")&&String(sfha).toUpperCase()==="F")base=82;
    else if(zone.includes("X"))base=68;
  }
  return Math.round((base*.65)+(elev*.35));
}
function hurricaneIndex(lat,lon,state,exp,wind){
  let s=30;
  const coastal=["FL","TX","LA","MS","AL","GA","SC","NC","VA"];
  if(coastal.includes(state))s+=25;
  if(state==="FL")s+=25;
  if(lat<31 && lon<-79 && lon>-88)s+=12;
  if(lat>24 && lat<36 && lon<-75 && lon>-98)s+=8;
  s += exposurePenalty(exp)*.8;
  s += (wind-130)/5;
  return Math.min(100,Math.round(s));
}
async function geocodeArcGIS(address){
  const url="https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=1&outFields=*&SingleLine="+encodeURIComponent(address);
  const r=await fetch(url);
  if(!r.ok)throw new Error("ArcGIS geocoder did not respond.");
  const j=await r.json();
  const c=j.candidates && j.candidates[0];
  if(!c)throw new Error("No geocoding match found. Try a more complete address.");
  return {lat:c.location.y, lon:c.location.x, matched:c.address, state:c.attributes.Region || "", county:c.attributes.Subregion || ""};
}
async function queryFema(lat,lon){
  const endpoint="https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";
  const p=new URLSearchParams({
    f:"json",
    geometry:JSON.stringify({x:lon,y:lat,spatialReference:{wkid:4326}}),
    geometryType:"esriGeometryPoint",
    inSR:"4326",
    spatialRel:"esriSpatialRelIntersects",
    outFields:"*",
    returnGeometry:"false"
  });
  const r=await fetch(endpoint+"?"+p.toString());
  if(!r.ok)throw new Error("FEMA NFHL service did not respond.");
  const j=await r.json();
  const a=(j.features&&j.features[0]&&j.features[0].attributes)||null;
  if(!a)return {zone:"Not Found",subtype:"No FEMA polygon returned at point",sfha:"--",source:"FEMA NFHL queried",bfe:{value:null,display:"Not returned",datum:""},raw:null};
  return {zone:a.FLD_ZONE||"Unknown",subtype:a.ZONE_SUBTY||"",sfha:a.SFHA_TF||"--",source:"FEMA NFHL MapServer Layer 28",bfe:normalizeBFE(a),raw:a};
}
function mapIframe(lat,lon){
  const bbox=[lon-0.025,lat-0.018,lon+0.025,lat+0.018].join(",");
  return `<iframe src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}"></iframe>`;
}

function drawBuilding(scores){
  const roofL=level(scores.roofAdj), envL=level(scores.openings), structL=level(scores.loadpathAdj), floodL=level(scores.flood);
  const roofC=colorByLevel(roofL), envC=colorByLevel(envL), structC=colorByLevel(structL), floodC=colorByLevel(floodL);
  const storyLabel = stories===2 ? "2-STORY BUILDING" : "1-STORY BUILDING";
  const selectedZone = sval("windZone");
  const zText = selectedZone==="1" ? "ZONE 1 FIELD" : selectedZone==="2" ? "ZONE 2 EDGE" : "ZONE 3 CORNER";
  const exp = sval("exposure");
  const floorMid = stories===2 ? `
      <line x1="190" y1="220" x2="430" y2="260" stroke="rgba(255,255,255,.55)" stroke-width="2"/>
      <line x1="430" y1="260" x2="555" y2="205" stroke="rgba(255,255,255,.55)" stroke-width="2"/>
      <text x="80" y="240" fill="#9fb2cc" font-size="11">Level 2</text>
  ` : "";
  const windowSecond = stories===2 ? `
      <rect x="245" y="160" width="38" height="52" rx="4" fill="#67c8ff" stroke="#0b1424" stroke-width="3"/>
      <rect x="335" y="175" width="38" height="52" rx="4" fill="#67c8ff" stroke="#0b1424" stroke-width="3"/>
      <polygon points="478,170 515,154 515,203 478,221" fill="#67c8ff" stroke="#0b1424" stroke-width="3"/>
  ` : "";
  const heightLabel = stories===2 ? "two-floor vertical load path" : "single-floor load path";

  document.getElementById("buildingGraphic").innerHTML = `
  <svg width="720" height="290" viewBox="0 0 720 430" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgIso" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#071426"/>
        <stop offset="1" stop-color="#102846"/>
      </linearGradient>
      <linearGradient id="glass" x1="0" x2="1">
        <stop offset="0" stop-color="#7ed6ff"/>
        <stop offset="1" stop-color="#2f80ed"/>
      </linearGradient>
      <filter id="dropIso">
        <feDropShadow dx="0" dy="16" stdDeviation="10" flood-color="#000" flood-opacity=".45"/>
      </filter>
      <pattern id="gridIso" width="24" height="24" patternUnits="userSpaceOnUse">
        <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(255,255,255,.04)" stroke-width="1"/>
      </pattern>
    </defs>

    <rect x="0" y="0" width="720" height="430" fill="url(#bgIso)"/>
    <rect x="0" y="0" width="720" height="430" fill="url(#gridIso)"/>

    <text x="28" y="36" fill="#ffffff" font-size="18" font-weight="800">Building Component Risk Diagram</text>
    <text x="28" y="60" fill="#9fb2cc" font-size="12">${storyLabel} • Exposure ${exp} • ${zText}</text>

    <g transform="translate(40,10)" filter="url(#dropIso)">
      <!-- ground platform -->
      <polygon points="105,335 430,390 640,300 315,245" fill="rgba(77,163,255,.13)" stroke="#35577c" stroke-width="2"/>
      <polygon points="128,312 415,360 592,286 305,238" fill="${floodC}" opacity=".88" stroke="#d8e2f2" stroke-width="2"/>
      <text x="390" y="350" fill="#07111f" font-size="13" font-weight="900">FLOOD / SITE INTERFACE</text>

      <!-- main building mass -->
      <polygon points="190,130 430,170 430,360 190,320" fill="${structC}" stroke="#d8e2f2" stroke-width="2"/>
      <polygon points="430,170 555,115 555,305 430,360" fill="${envC}" stroke="#d8e2f2" stroke-width="2"/>
      <polygon points="190,130 315,75 555,115 430,170" fill="${roofC}" stroke="#d8e2f2" stroke-width="2"/>

      <!-- subtle component lines -->
      <line x1="190" y1="175" x2="430" y2="215" stroke="rgba(255,255,255,.28)" stroke-width="1"/>
      <line x1="190" y1="255" x2="430" y2="295" stroke="rgba(255,255,255,.28)" stroke-width="1"/>
      <line x1="430" y1="215" x2="555" y2="160" stroke="rgba(255,255,255,.28)" stroke-width="1"/>
      <line x1="430" y1="295" x2="555" y2="240" stroke="rgba(255,255,255,.28)" stroke-width="1"/>
      ${floorMid}

      <!-- openings -->
      <rect x="245" y="245" width="42" height="58" rx="4" fill="url(#glass)" stroke="#0b1424" stroke-width="3"/>
      <rect x="340" y="260" width="42" height="58" rx="4" fill="url(#glass)" stroke="#0b1424" stroke-width="3"/>
      <polygon points="480,238 520,220 520,278 480,296" fill="url(#glass)" stroke="#0b1424" stroke-width="3"/>
      ${windowSecond}

      <!-- vertical load path lines -->
      <line x1="215" y1="138" x2="215" y2="320" stroke="rgba(255,255,255,.75)" stroke-width="3" stroke-dasharray="8,6"/>
      <line x1="405" y1="166" x2="405" y2="355" stroke="rgba(255,255,255,.75)" stroke-width="3" stroke-dasharray="8,6"/>
      <line x1="532" y1="125" x2="532" y2="314" stroke="rgba(255,255,255,.75)" stroke-width="3" stroke-dasharray="8,6"/>

      <!-- zone badges -->
      <g>
        <circle cx="318" cy="105" r="28" fill="rgba(0,0,0,.35)" stroke="#fff" stroke-width="4"/>
        <text x="318" y="113" text-anchor="middle" fill="#fff" font-size="20" font-weight="900">R</text>
      </g>
      <g>
        <circle cx="505" cy="190" r="27" fill="rgba(0,0,0,.35)" stroke="#fff" stroke-width="4"/>
        <text x="505" y="198" text-anchor="middle" fill="#fff" font-size="18" font-weight="900">O</text>
      </g>
      <g>
        <circle cx="300" cy="210" r="27" fill="rgba(0,0,0,.35)" stroke="#fff" stroke-width="4"/>
        <text x="300" y="218" text-anchor="middle" fill="#fff" font-size="18" font-weight="900">S</text>
      </g>
      <g>
        <circle cx="292" cy="338" r="27" fill="rgba(0,0,0,.35)" stroke="#fff" stroke-width="4"/>
        <text x="292" y="346" text-anchor="middle" fill="#fff" font-size="18" font-weight="900">F</text>
      </g>
    </g>

    <!-- right legend -->
    <g transform="translate(545,70)" font-family="Arial">
      <rect x="0" y="0" width="145" height="185" rx="14" fill="rgba(7,16,30,.76)" stroke="#26364f"/>
      <text x="16" y="28" fill="#fff" font-size="13" font-weight="800">Component Status</text>

      <circle cx="22" cy="55" r="7" fill="${roofC}"/><text x="38" y="59" fill="#dfe9f8" font-size="12">R Roof: ${roofL}</text>
      <circle cx="22" cy="83" r="7" fill="${envC}"/><text x="38" y="87" fill="#dfe9f8" font-size="12">O Openings: ${envL}</text>
      <circle cx="22" cy="111" r="7" fill="${structC}"/><text x="38" y="115" fill="#dfe9f8" font-size="12">S Structure: ${structL}</text>
      <circle cx="22" cy="139" r="7" fill="${floodC}"/><text x="38" y="143" fill="#dfe9f8" font-size="12">F Flood: ${floodL}</text>

      <text x="16" y="170" fill="#9fb2cc" font-size="11">${heightLabel}</text>
    </g>

    <!-- bottom technical tags -->
    <g font-family="Arial">
      <rect x="28" y="382" width="128" height="28" rx="14" fill="rgba(77,163,255,.16)" stroke="rgba(77,163,255,.32)"/>
      <text x="92" y="401" text-anchor="middle" fill="#9dccff" font-size="12" font-weight="800">Wind Zone ${selectedZone}</text>
      <rect x="166" y="382" width="128" height="28" rx="14" fill="rgba(166,108,255,.16)" stroke="rgba(166,108,255,.32)"/>
      <text x="230" y="401" text-anchor="middle" fill="#c5a9ff" font-size="12" font-weight="800">Exposure ${exp}</text>
      <rect x="304" y="382" width="148" height="28" rx="14" fill="rgba(255,200,87,.13)" stroke="rgba(255,200,87,.32)"/>
      <text x="378" y="401" text-anchor="middle" fill="#ffd982" font-size="12" font-weight="800">${storyLabel}</text>
    </g>
  </svg>`;
}

function radar(values){
  const labels=["Roof","Openings","Load Path","Flood","Drainage","Code Era"];
  const cx=165, cy=142, maxR=92;
  let axes="", polyPts="", labelHtml="";
  for(let i=0;i<6;i++){
    const ang=-Math.PI/2 + i*(2*Math.PI/6);
    const x=cx+Math.cos(ang)*maxR, y=cy+Math.sin(ang)*maxR;
    axes+=`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#26364f"/>`;
    const lx=cx+Math.cos(ang)*(maxR+36), ly=cy+Math.sin(ang)*(maxR+24);
    labelHtml+=`<text x="${lx}" y="${ly}" fill="#9fb2cc" font-size="11" text-anchor="middle">${labels[i]}</text>`;
    const rr=maxR*(values[i]/100);
    polyPts+=`${cx+Math.cos(ang)*rr},${cy+Math.sin(ang)*rr} `;
  }
  let rings="";
  for(let r of [23,46,69,92]) rings+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#26364f"/>`;
  document.getElementById("radar").innerHTML=`<svg width="360" height="285" viewBox="0 0 360 285">${rings}${axes}<polygon points="${polyPts}" fill="rgba(77,163,255,.32)" stroke="#4da3ff" stroke-width="2"/>${labelHtml}</svg>`;
}

function recommendations(inputs, fScore, fema){
  const recs=[];
  const exp=sval("exposure"), wz=sval("windZone");
  const floodZone=String(fema.zone||"").toUpperCase();

  if(inputs.loadpathAdj < 70 || inputs.roofAdj < 70){
    recs.push(["1","Roof / Load Path Upgrade","Review hurricane clips, straps, roof-to-wall connections, roof deck attachment, and continuous load path from roof framing to foundation.","Priority: High","bad"]);
  }
  if(inputs.openings < 70){
    recs.push(["2","Opening Protection","Consider impact-rated windows/doors or approved shutter systems for glazed openings, doors, garage doors, and other wind-borne-debris vulnerable openings.","Priority: High","bad"]);
  }
  if(fScore < 60 || floodZone.includes("A") || floodZone.includes("V")){
    recs.push(["3","Flood Mitigation / Flood Vents","For enclosed areas below elevated floors, evaluate engineered or non-engineered flood openings/flood vents, equipment elevation, and dry/wet floodproofing options where allowed.","Priority: Critical Review","crit"]);
  }
  if(inputs.drainage < 70){
    recs.push(["4","Site Drainage Improvement","Improve grading, downspout discharge, surface drainage, and stormwater routing to reduce ponding and water intrusion risk.","Priority: Medium","warn"]);
  }
  if(exp==="C" || exp==="D" || wz==="2" || wz==="3"){
    recs.push(["5","Exposure / Edge-Zone Detailing","Because Exposure "+exp+" and selected Zone "+wz+" increase wind demand, review edge/corner fastening schedules, roof perimeter detailing, and opening protection strategy.","Priority: Technical Review","warn"]);
  }
  if(inputs.codeEra < 70){
    recs.push(["6","Code Era Verification","Verify original permit era, retrofit history, product approvals, and whether the building predates current wind and flood-resilience requirements.","Priority: Documentation","blue"]);
  }
  if(inputs.roofType==="tile"){
    recs.push(["7","Tile Roof Verification","Verify tile attachment method, underlayment condition, uplift resistance, and debris impact risk.","Priority: Targeted Roof Review","warn"]);
  }
  if(inputs.roofType==="metal"){
    recs.push(["8","Metal Roof Verification","Verify panel attachment, edge fastening, corrosion exposure, and product approval documentation.","Priority: Targeted Roof Review","warn"]);
  }
  if(recs.length===0){
    recs.push(["1","Monitoring & Documentation","Maintain photographic records, post-storm inspection logs, product approvals, and annual review of flood/wind exposure conditions.","Priority: Monitoring","good"]);
  }
  document.getElementById("recommendations").innerHTML = recs.slice(0,8).map(r=>`
    <div class="rec">
      <div class="num ${r[4]}">${r[0]}</div>
      <b>${r[1]}</b>
      <p>${r[2]}</p>
      <span class="tag ${r[4]}">${r[3]}</span>
    </div>`).join("");
}
function calculateAndRender(geo,fema){
  const exp=sval("exposure"), wind=val("windSpeed"), wz=sval("windZone"), roofType=sval("roofType");
  const baseRoof=val("roof"), openings=val("openings"), loadpath=val("loadpath"), drainage=val("drainage"), elevation=val("elevation"), codeEra=val("codeEra");
  const ep=exposurePenalty(exp), zp=zonePenalty(wz);
  const storyPenalty = stories===2 ? 5 : 0;
  const roofTypeModifier = roofEnvelopeAdjustment(roofType);
  const roofAdj=Math.max(0,baseRoof-ep-zp-storyPenalty+roofTypeModifier);
  const loadpathAdj=Math.max(0,loadpath-(stories===2?6:0)-zp*.35);
  const fScore=floodScore(fema.zone,fema.sfha,elevation);
  const hi=hurricaneIndex(geo.lat,geo.lon,geo.state,exp,wind);
  const total=Math.round(roofAdj*.18 + openings*.14 + loadpathAdj*.22 + fScore*.20 + drainage*.10 + codeEra*.08 + elevation*.08);
  const [classification,pill]=cls(total);

  document.getElementById("score").textContent=total+"/100";
  document.getElementById("scoreClass").innerHTML=`<span class="pill ${pill}">${classification}</span>`;
  document.getElementById("floodZone").textContent=fema.zone||"--";
  document.getElementById("sfha").textContent="SFHA: "+(fema.sfha||"--")+" "+(fema.subtype||"");
  const bfe = fema.bfe || {display:"Not returned",datum:""};
  document.getElementById("bfeValue").textContent = bfe.display || "Not returned";
  document.getElementById("bfeDatum").textContent = bfe.datum ? ("Datum: " + bfe.datum) : "Manual FIRM review may be required";
  document.getElementById("bfeRow").textContent = (bfe.display || "Not returned") + (bfe.datum ? " / " + bfe.datum : "");
  document.getElementById("expMetric").textContent="Exposure "+exp;
  document.getElementById("windMetric").textContent=wind+" mph • Zone "+wz;
  document.getElementById("hIndex").textContent=hi+"/100";
  document.getElementById("matched").textContent=geo.matched||"--";
  document.getElementById("coords").textContent=geo.lat.toFixed(5)+", "+geo.lon.toFixed(5);
  document.getElementById("county").textContent=(geo.county||"--")+", "+(geo.state||"--");
  document.getElementById("femaSource").textContent=fema.source||"--";
  document.getElementById("zoneStory").textContent="Zone "+wz+" / "+stories+" story";
  document.getElementById("roofTypeDisplay").textContent=roofEnvelopeLabel(roofType);
  document.getElementById("notes").textContent=fema.zone==="Not Found"?"FEMA polygon not found at point; manual review recommended. All roof/envelope type effects are preliminary screening assumptions only, not a final engineering determination.":"Preliminary screening only. Roof/envelope type effects are assumptions pending field verification and not a final engineering determination.";
  document.getElementById("mapbox").innerHTML=mapIframe(geo.lat,geo.lon);

  const scores={roofAdj, openings, loadpathAdj, flood:fScore};
  drawBuilding(scores);
  radar([roofAdj,openings,loadpathAdj,fScore,drainage,codeEra]);
  recommendations({roofAdj,openings,loadpathAdj,drainage,elevation,codeEra,roofType}, fScore, fema);

  snapshot={generatedAt:new Date().toISOString(),address:document.getElementById("address").value,geo,fema,stories,exposure:exp,windZone:wz,windSpeed:wind,roofType:roofEnvelopeLabel(roofType),scores:{roofAdj,openings,loadpathAdj,flood:fScore,drainage,codeEra,total,roofTypeModifier},classification,hurricaneExposureIndex:hi};
}


async function runAssessment(){
  const address=document.getElementById("address").value.trim();
  if(!address){setStatus("Enter an address first.");return;}
  setStatus("Geocoding address...");
  try{
    const geo=await geocodeArcGIS(address);
    lastGeo=geo;
    setStatus("Address found:\n"+geo.matched+"\n\nQuerying FEMA NFHL flood zone...");
    let fema;
    try{fema=await queryFema(geo.lat,geo.lon);}
    catch(e){fema={zone:"Unavailable",subtype:e.message,sfha:"--",source:"FEMA lookup unavailable",bfe:{value:null,display:"Unavailable",datum:""}};}
    lastFema=fema;
    setStatus("Screening complete.\n\nGeocoder: ArcGIS World Geocoding\nFlood data: "+fema.source+"\nExposure and wind zone are user-selected preliminary inputs.");
    calculateAndRender(geo,fema);
  }catch(e){
    setStatus("Screening failed:\n"+e.message+"\n\nTry a full address with city, state, and ZIP code.");
    document.getElementById("score").textContent="Error";
    document.getElementById("scoreClass").textContent="See status panel";
  }
}
function downloadSnapshot(){
  const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="RiskAtlas25_Assessment_Snapshot_v3.json"; a.click();
}
window.onload=()=>runAssessment();
