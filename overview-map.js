import { displayDate } from './display.js';
// Map marks rounded town centres only, never a facility coordinate.
const key = text => String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function townIndex(data) {
  const index = new Map();
  for (const town of data?.towns || []) for (const alias of [town.label,...town.aliases]) {
    const name = key(alias); if (!name || name.length < 3) continue;
    if (!index.has(name)) index.set(name,town); else if(index.get(name)?.geoname_id!==town.geoname_id)index.set(name,null);
  }
  return index;
}
export function approximateTown(record,index) {
  const names = [record.region,record.location,record.name,record.facility_name].filter(Boolean);
  for (const name of names) {
    if (/oblast|krai|republic|область|край|республика|district|autonomous|disputed/i.test(name)) continue;
    const cleaned=name.replace(/\([^)]*\)/g,'').replace(/\b(refinery|refineries|data cent(?:er|re)|warehouse|logistics (?:center|centre|hub)|yandex|wildberries|ozon|reported|area|near)\b/gi,'').trim();
    const town=index.get(key(cleaned)); if(town)return town;
    for(const fragment of cleaned.split(/[,/]/)) { const match=index.get(key(fragment));if(match)return match; }
  }
  return null;
}
export function groupTowns(records,reports,data) {
  const index=townIndex(data),groups=new Map();let unmapped=0;
  for(const record of records){const town=approximateTown(record,index);if(!town){unmapped++;continue;}if(!groups.has(town.geoname_id))groups.set(town.geoname_id,{town,records:[],reports:[]});groups.get(town.geoname_id).records.push(record);}
  for(const report of reports){const town=approximateTown(report,index);if(!town)continue;if(!groups.has(town.geoname_id))groups.set(town.geoname_id,{town,records:[],reports:[]});groups.get(town.geoname_id).reports.push(report);}
  return {groups:[...groups.values()],unmapped};
}
let map,markers,tiles,lastZoom,mapMessage;
export function renderOverviewMap(container, records,reports,locations,preferences,onRecord,onReport){
  const grouped=groupTowns(records,reports,locations);
  const coverage=document.getElementById('mapCoverage');if(coverage)coverage.textContent=`${records.length-grouped.unmapped}/${records.length} facilities matched to town centres · ${grouped.groups.length} places · ${grouped.unmapped} without a town match`;
  if(!globalThis.L){container.textContent='Map library unavailable. Facilities and reports remain available in their tabs.';return;}
  if(!map){map=L.map(container,{maxZoom:10,minZoom:2,scrollWheelZoom:false}).setView([57,55],4);markers=L.layerGroup().addTo(map);map.attributionControl.setPrefix(false);map.attributionControl.addAttribution('Town centres: <a href="https://www.geonames.org/">GeoNames</a> · approximate');}
  if(preferences.mapTiles&&!tiles){
    tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:10,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'});
    tiles.on('tileerror',()=>{if(!tiles)return;tiles.remove();tiles=null;if(!mapMessage){mapMessage=document.createElement('div');mapMessage.className='map-basemap-note';mapMessage.textContent='Map tiles unavailable. Town markers remain approximate.';container.append(mapMessage);}});
    tiles.on('tileload',()=>{mapMessage?.remove();mapMessage=null;});tiles.addTo(map);
  }else if(!preferences.mapTiles&&tiles){tiles.remove();tiles=null;mapMessage?.remove();mapMessage=null;}
  markers.clearLayers();
  for(const group of grouped.groups){
    const point=group.town.town_center;if(!Array.isArray(point)||point.length!==2)continue;
    const marker=L.circleMarker(point,{radius:Math.min(17,7+Math.sqrt(group.records.length+group.reports.length)),color:group.reports.length?'#ffcf88':'#d1baff',fillColor:group.reports.length?'#f1a648':'#9274db',fillOpacity:.8,weight:2}).addTo(markers);
    const box=document.createElement('div'),title=document.createElement('strong');title.textContent=group.town.label+' · town centre';box.append(title);
    const note=document.createElement('p');note.textContent=`${group.records.length} facilities · ${group.reports.length} reports. Approximate town marker; not a facility position.`;box.append(note);
    for(const record of group.records){const button=document.createElement('button');button.type='button';button.className='map-record-button';button.textContent=record.name;button.addEventListener('click',()=>onRecord(record));box.append(button);}
    for(const report of group.reports.filter(report=>!group.records.some(record=>record.id===report.facility_id))){const button=document.createElement('button');button.type='button';button.className='map-record-button';button.textContent=`Incident: ${report.facility_name} · ${displayDate(report.event_date||report.updates?.[0]?.posted_at)}`;button.addEventListener('click',()=>onReport(report));box.append(button);}
    marker.bindPopup(box,{maxHeight:250,maxWidth:320});const element=marker.getElement();if(element){element.setAttribute('role','button');element.setAttribute('tabindex','0');element.setAttribute('aria-label',`${group.town.label}: ${group.records.length} facilities, ${group.reports.length} reports`);element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();marker.openPopup();}});}marker.bindTooltip(`${group.town.label}: ${group.records.length} facilities / ${group.reports.length} reports`);
  }
  if(lastZoom!==preferences.mapZoom){map.setView(preferences.mapZoom==='country'?[60,85]:[56,48],preferences.mapZoom==='country'?3:4);lastZoom=preferences.mapZoom;}
  requestAnimationFrame(()=>map.invalidateSize());
}
