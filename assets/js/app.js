let lastGeo=null, lastFema=null, snapshot={}, stories=1, previousExposure=null, debrisTrigger=false;


function clampScore(v){
  return Math.max(0, Math.min(100, Math.round(v)));
}

function applyExposureEscalation(prevExp, nextExp){
  const escalatedFromB = prevExp === "B" && (nextExp === "C" || nextExp === "D");
  debrisTrigger = escalatedFromB;
  if(!escalatedFromB) return;

  const roofEl = document.getElementById("roof");
  const openingsEl = document.getElementById("openings");
  const roofPenalty = nextExp === "D" ? 12 : 8;
  const openingsPenalty = nextExp === "D" ? 14 : 10;

  roofEl.value = clampScore((+roofEl.value) - roofPenalty);
  openingsEl.value = clampScore((+openingsEl.value) - openingsPenalty);
}
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
  if(type==="metal") return 8;
  if(type==="tile") return -10;
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


function recalculateIfReady(){
  if(lastGeo && lastFema) calculateAndRender(lastGeo,lastFema);
}

function drawBuilding(scores){
  const roofL=level(scores.roofAdj), openingsL=level(scores.openings), structL=level(scores.loadpathAdj), floodL=level(scores.flood);
  const roofC=colorByLevel(roofL), openingsC=colorByLevel(openingsL), structC=colorByLevel(structL), floodC=colorByLevel(floodL);
  const storyLabel = stories===2 ? "2-STORY BUILDING" : "1-STORY BUILDING";
  const selectedZone = sval("windZone");
  const zText = selectedZone==="1" ? "ZONE 1 FIELD" : selectedZone==="2" ? "ZONE 2 EDGE" : "ZONE 3 CORNER";
  const exp = sval("exposure");
  const floorBreak = stories===2 ? `
      <line x1="226" y1="228" x2="470" y2="270" class="line"/>
      <line x1="470" y1="270" x2="618" y2="209" class="line"/>
    ` : "";
  const upperOpenings = stories===2 ? `
      <rect x="292" y="172" width="42" height="48" rx="2" class="window"/>
      <rect x="390" y="188" width="42" height="48" rx="2" class="window"/>
      <polygon points="548,180 586,164 586,212 548,228" class="window"/>
    ` : "";

  document.getElementById("buildingGraphic").innerHTML = `
  <svg width="100%" height="100%" viewBox="0 0 920 470" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Building zone risk map">
    <defs>
      <linearGradient id="bgTech" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#081729"/><stop offset="1" stop-color="#0f2742"/></linearGradient>
      <pattern id="gridTech" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="rgba(255,255,255,.045)" stroke-width="1"/></pattern>
      <linearGradient id="roofFace" x1="0" x2="1"><stop offset="0" stop-color="${roofC}"/><stop offset="1" stop-color="#dce8f7" stop-opacity=".24"/></linearGradient>
      <linearGradient id="openFace" x1="0" x2="1"><stop offset="0" stop-color="${openingsC}"/><stop offset="1" stop-color="#dce8f7" stop-opacity=".24"/></linearGradient>
      <linearGradient id="upperFace" x1="0" x2="1"><stop offset="0" stop-color="${structC}"/><stop offset="1" stop-color="#dce8f7" stop-opacity=".2"/></linearGradient>
      <linearGradient id="lowerFace" x1="0" x2="1"><stop offset="0" stop-color="${structC}"/><stop offset="1" stop-color="#dce8f7" stop-opacity=".1"/></linearGradient>
      <linearGradient id="foundationFace" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${floodC}"/><stop offset="1" stop-color="#0c1f36"/></linearGradient>
      <style>
        .line{stroke:rgba(219,231,247,.62);stroke-width:1.5}
        .outline{stroke:#dde7f4;stroke-width:2.1}
        .label{font:700 11px Inter,Segoe UI,Arial,sans-serif;fill:#d4e3f5;letter-spacing:.07em}
        .zoneTag{fill:#0a1525;stroke:#d7e3f3;stroke-width:1.5}
        .zoneTxt{font:800 13px Inter,Segoe UI,Arial,sans-serif;fill:#eaf2ff}
        .legendTxt{font:600 12px Inter,Segoe UI,Arial,sans-serif;fill:#dce7f6}
        .window{fill:#78bdea;stroke:#153251;stroke-width:2}
      </style>
    </defs>

    <rect x="0" y="0" width="920" height="470" fill="url(#bgTech)"/>
    <rect x="0" y="0" width="920" height="470" fill="url(#gridTech)"/>

    <text x="24" y="34" fill="#f1f6ff" font-size="18" font-weight="800">Building Zone Risk Map</text>
    <text x="24" y="56" fill="#b7cbe3" font-size="12" font-weight="700">${storyLabel} • Exposure ${exp} • ${zText}</text>

    <g transform="translate(58,18)">
      <polygon points="120,346 498,408 736,311 360,250" fill="rgba(98,147,197,.14)" class="outline"/>

      <polygon points="226,132 470,174 470,338 226,296" fill="url(#upperFace)" class="outline"/>
      <polygon points="226,228 470,270 470,338 226,296" fill="url(#lowerFace)" class="outline" opacity=".95"/>
      <polygon points="470,174 618,113 618,278 470,338" fill="url(#openFace)" class="outline"/>
      <polygon points="470,246 618,185 618,278 470,338" fill="url(#openFace)" class="outline" opacity=".88"/>
      <polygon points="226,132 374,72 618,113 470,174" fill="url(#roofFace)" class="outline"/>
      <polygon points="226,296 470,338 470,374 226,332" fill="url(#foundationFace)" class="outline"/>
      <polygon points="470,338 618,278 618,315 470,374" fill="url(#foundationFace)" class="outline"/>

      <line x1="226" y1="176" x2="470" y2="218" class="line"/>
      <line x1="470" y1="218" x2="618" y2="157" class="line"/>
      ${floorBreak}

      <rect x="292" y="244" width="42" height="52" rx="2" class="window"/>
      <rect x="390" y="260" width="42" height="52" rx="2" class="window"/>
      <polygon points="548,238 586,222 586,275 548,291" class="window"/>
      ${upperOpenings}

      <g transform="translate(374,95)"><rect x="-24" y="-14" width="48" height="28" rx="14" class="zoneTag"/><text text-anchor="middle" y="5" class="zoneTxt">Z1</text></g>
      <g transform="translate(326,202)"><rect x="-24" y="-14" width="48" height="28" rx="14" class="zoneTag"/><text text-anchor="middle" y="5" class="zoneTxt">Z2</text></g>
      <g transform="translate(326,274)"><rect x="-24" y="-14" width="48" height="28" rx="14" class="zoneTag"/><text text-anchor="middle" y="5" class="zoneTxt">Z3</text></g>
      <g transform="translate(548,220)"><rect x="-24" y="-14" width="48" height="28" rx="14" class="zoneTag"/><text text-anchor="middle" y="5" class="zoneTxt">Z4</text></g>
      <g transform="translate(338,352)"><rect x="-24" y="-14" width="48" height="28" rx="14" class="zoneTag"/><text text-anchor="middle" y="5" class="zoneTxt">Z5</text></g>

      <text x="148" y="92" class="label">ROOF SYSTEM</text>
      <text x="122" y="194" class="label">UPPER WALLS</text>
      <text x="116" y="268" class="label">LOWER WALLS</text>
      <text x="642" y="216" class="label">OPENINGS</text>
      <text x="150" y="366" class="label">FOUNDATION</text>
    </g>

    <g transform="translate(654,72)">
      <rect x="0" y="0" width="240" height="292" rx="12" fill="rgba(8,18,30,.86)" stroke="#2a3e5a"/>
      <text x="16" y="28" fill="#f1f6ff" font-size="14" font-weight="800">Zone Legend & Risk</text>
      <text x="16" y="48" fill="#9fb6d3" font-size="11">Dynamic scoring and exposure logic preserved</text>

      <rect x="16" y="64" width="10" height="10" fill="${roofC}"/><text x="34" y="73" class="legendTxt">Z1 Roof system: ${roofL}</text>
      <rect x="16" y="89" width="10" height="10" fill="${structC}"/><text x="34" y="98" class="legendTxt">Z2 Upper walls: ${structL}</text>
      <rect x="16" y="114" width="10" height="10" fill="${structC}"/><text x="34" y="123" class="legendTxt">Z3 Lower walls: ${structL}</text>
      <rect x="16" y="139" width="10" height="10" fill="${openingsC}"/><text x="34" y="148" class="legendTxt">Z4 Openings: ${openingsL}</text>
      <rect x="16" y="164" width="10" height="10" fill="${floodC}"/><text x="34" y="173" class="legendTxt">Z5 Foundation: ${floodL}</text>

      <line x1="16" y1="188" x2="224" y2="188" stroke="#2a3e5a"/>
      <text x="16" y="210" fill="#cde0f8" font-size="11">Annotations</text>
      <text x="16" y="228" fill="#9fb6d3" font-size="11">• Wind zone penalties: ${selectedZone}</text>
      <text x="16" y="244" fill="#9fb6d3" font-size="11">• Exposure category: ${exp}</text>
      <text x="16" y="260" fill="#9fb6d3" font-size="11">• Roof envelope adjustments applied</text>
      <text x="16" y="276" fill="#9fb6d3" font-size="11">• Mobile-safe high-contrast labels</text>
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
  const mpiLabel = (value)=>{
    const mpi = parseInt(value,10);
    if(!Number.isNaN(mpi) && mpi>=1 && mpi<=3) return "MPI: Critical Priority";
    if(!Number.isNaN(mpi) && mpi>=4 && mpi<=6) return "MPI: Moderate Priority";
    return "MPI: Lower Priority / Monitoring Recommended";
  };

  if(inputs.loadpathAdj < 70 || inputs.roofAdj < 70){
    recs.push(["1","Roof / Load Path Upgrade","Review hurricane clips, straps, roof-to-wall connections, roof deck attachment, and continuous load path from roof framing to foundation.","Priority: High","bad"]);
  }
  if(inputs.openings < 70 || debrisTrigger){
    recs.push(["2","Opening Protection","Consider impact-rated windows/doors or approved shutter systems for glazed openings, doors, garage doors, and other wind-borne-debris vulnerable openings.","Priority: High","bad"]);
  }
  if(debrisTrigger){
    recs.push(["2A","Windborne Debris Action","Exposure changed from B to "+exp+". Escalate impact-resistant envelope measures, debris-region product approvals, and immediate opening protection planning.","Priority: Immediate","crit"]);
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
    recs.push(["8","Metal Roof Verification","Verify metal panel attachment, edge fastening, corrosion exposure, and product approval documentation.","Priority: Targeted Roof Review","warn"]);
  }
  if(recs.length===0){
    recs.push(["1","Monitoring & Documentation","Maintain photographic records, post-storm inspection logs, product approvals, and annual review of flood/wind exposure conditions.","Priority: Monitoring","good"]);
  }
  document.getElementById("recommendations").innerHTML = recs.slice(0,8).map(r=>`
    <div class="rec">
      <div class="num ${r[4]}" title="Mitigation Priority Index (MPI): lower numbers are more urgent.">${r[0]}</div>
      <small class="mpi-caption">Mitigation Priority Index (MPI): ${r[0]} • ${mpiLabel(r[0])}</small>
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


async function downloadPdfReport(){
  if(!window.html2canvas || !window.jspdf){
    setStatus("PDF libraries not loaded. Refresh and try again.");
    return;
  }

  const addressValue = document.getElementById("address").value || "--";
  const sections = [
    {title:"Address Information", element:document.querySelector('.twocol .card:nth-child(2)')},
    {title:"Risk Summary", element:document.querySelector('.risk-summary')},
    {title:"Risk Profile Radar", element:document.getElementById("radar")},
    {title:"Building Diagram", element:document.getElementById("buildingGraphic")},
    {title:"Recommendations", element:document.getElementById("recommendations")}
  ];

  if(sections.some(s => !s.element)){
    setStatus("Unable to locate report sections for PDF capture.");
    return;
  }

  const originalStatus = document.getElementById("status").textContent;
  setStatus("Generating PDF report...");

  try{
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "pt", "letter");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 36;
    const contentWidth = pageWidth - (margin * 2);
    let y = margin;

    const addNewPageIfNeeded = (requiredHeight = 0) => {
      if(y + requiredHeight > pageHeight - margin){
        pdf.addPage();
        y = margin;
      }
    };

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.text("RiskAtlas25 Report", margin, y);
    y += 22;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);
    pdf.text(`Address: ${addressValue}`, margin, y, {maxWidth: contentWidth});
    y += 16;
    pdf.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
    y += 18;

    for(const section of sections){
      addNewPageIfNeeded(40);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(13);
      pdf.text(section.title, margin, y);
      y += 8;

      const canvas = await html2canvas(section.element, {
        backgroundColor: "#0b1526",
        scale: 2,
        useCORS: true
      });
      const imgData = canvas.toDataURL("image/png");
      const imgHeight = (canvas.height * contentWidth) / canvas.width;
      addNewPageIfNeeded(imgHeight + 14);
      pdf.addImage(imgData, "PNG", margin, y, contentWidth, imgHeight);
      y += imgHeight + 14;
    }

    pdf.save("RiskAtlas25_Report.pdf");
    setStatus("PDF report downloaded: RiskAtlas25_Report.pdf");
  }catch(e){
    setStatus(`PDF generation failed: ${e.message}`);
  }

  setTimeout(()=>{
    if(document.getElementById("status").textContent.includes("PDF")){
      setStatus(originalStatus);
    }
  }, 2500);
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
window.onload=()=>{
  previousExposure = sval("exposure");
  const recalcIds=["exposure","windZone","windSpeed","codeEra","roof","roofType","openings","loadpath","elevation","drainage"];
  recalcIds.forEach((id)=>{
    const el=document.getElementById(id);
    if(!el) return;
    if(id === "exposure"){
      el.addEventListener("change", ()=>{
        const nextExposure = sval("exposure");
        applyExposureEscalation(previousExposure, nextExposure);
        previousExposure = nextExposure;
        recalculateIfReady();
      });
      return;
    }
    el.addEventListener("change", recalculateIfReady);
  });
  runAssessment();
};
