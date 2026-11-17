// Local media is presentation evidence only; never an authenticity assertion.
const imagePath = value => typeof value === 'string' && /^img\/reports\/[A-Za-z0-9_-]+\.jpg$/.test(value);
const videoPath = value => typeof value === 'string' && /^media\/reports\/[A-Za-z0-9_-]+\.(mp4|webm)$/.test(value);
const sourcePath = value => typeof value === 'string' && /^https:\/\/t\.me\/supernova_plus\/[1-9]\d*$/.test(value);
export function reportMedia(report, manifest, thumbnail = photo => photo.path) {
  const result = [];
  for (const update of report.updates || []) {
    const additions = manifest?.schema_version === 1 ? manifest.by_post?.[String(update.post_id)] : [];
    const entries = [...(Array.isArray(additions) ? additions : []), ...(update.photos || []).map(photo => ({kind:'image', src:photo.path, thumbnail:thumbnail(photo), sha256:photo.sha256}))];
    for (const item of entries) {
      if (!item || !['image','video','telegram_video'].includes(item.kind)) continue;
      const source = sourcePath(item.source_url) ? item.source_url : update.source_url;
      if (!sourcePath(source) || source !== update.source_url) continue;
      if (item.kind === 'image' && !imagePath(item.src) || item.kind === 'video' && !videoPath(item.src) || item.kind === 'telegram_video' && item.src) continue;
      result.push({...item, thumbnail: imagePath(item.thumbnail) ? item.thumbnail : item.kind === 'image' ? item.src : null, source_url:source, post_id:update.post_id, posted_at:update.posted_at, report_approval_status:report.approval_status, approval_scope:report.approval?.scope || null, media_origin:'incident', media_verification:explicitMediaVerification(item.media_verification)});
    }
  }
  return orderAndDeduplicateMedia(result);
}
export function facilityGalleryMedia(manifest, facilityId) {
  const entries = manifest?.schema_version === 1 ? manifest.facility_photos?.[facilityId] : [];
  if (!Array.isArray(entries)) return [];
  const media = entries.filter(item => {
    if (!item || item.kind !== 'image' || !imagePath(item.src)) return false;
    try { const url = new URL(item.source_url); if (url.protocol !== 'https:' || url.username || url.password) return false; } catch { return false; }
    return true;
  }).map(item => ({...item, thumbnail:imagePath(item.thumbnail) ? item.thumbnail : item.src, source_label:item.source_label || 'Source page ↗', media_origin:'facility', media_verification:item.media_verification === 'source_attributed' ? 'source_attributed' : explicitMediaVerification(item.media_verification), captured_at:validMediaDate(item.captured_at) !== null ? item.captured_at : validMediaDate(item.capture_date) !== null ? item.capture_date : null}));
  return orderAndDeduplicateMedia(media);
}
const validMediaDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const explicitMediaVerification = value => ['verified','proven'].includes(value) ? value : 'unverified';
function mediaPriority(item) {
  if (item.media_origin === 'facility') return 2;
  return item.media_verification === 'verified' || item.media_verification === 'proven' || item.report_approval_status === 'approved' ? 0 : 1;
}
function mediaDate(item) { return validMediaDate(item.captured_at) ?? validMediaDate(item.capture_date) ?? validMediaDate(item.posted_at); }
export function orderAndDeduplicateMedia(items) {
  const ordered = items.map((item,index)=>({item,index})).sort((a,b)=>mediaPriority(a.item)-mediaPriority(b.item) || ((mediaDate(b.item) ?? -Infinity)-(mediaDate(a.item) ?? -Infinity)) || a.index-b.index);
  const seen = new Set(), result=[];
  for (const {item} of ordered) {
    const key = item.src || `${item.kind}:${item.source_url || item.post_id || ''}`;
    const hashKey = /^[a-f0-9]{64}$/.test(item.sha256 || '') ? `sha256:${item.sha256}` : null;
    if (seen.has(key) || (hashKey && seen.has(hashKey))) continue;
    seen.add(key); if(hashKey)seen.add(hashKey); result.push(item);
  }
  return result;
}
export function orderedFacilityMedia(reports, manifest, facilityId, thumbnail) {
  const incidents = (reports || []).filter(report=>report.facility_id===facilityId).flatMap(report=>reportMedia(report,manifest,thumbnail));
  const facility = facilityGalleryMedia(manifest,facilityId);
  return orderAndDeduplicateMedia([...incidents,...facility]);
}
const el = (tag, className, text) => { const node = document.createElement(tag); node.className = className || ''; if (text) node.textContent = text; return node; };
export function mediaPreview(items) { return items.find(item => item.thumbnail)?.thumbnail || null; }
export function createMediaGallery(items, name) {
  const root = el('section','media-gallery'); root.setAttribute('aria-label',`Source media for ${name}`);
  const toolbar = el('div','gallery-toolbar'), previous = el('button','button','←'), next = el('button','button','→'), counter = el('span','gallery-counter');
  previous.type = next.type = 'button'; previous.setAttribute('aria-label','Previous media'); next.setAttribute('aria-label','Next media'); counter.setAttribute('aria-live','polite');
  toolbar.append(previous,counter,next);
  const track = el('div','gallery-track'); track.tabIndex = 0; track.setAttribute('aria-label','Swipe or use left and right arrow keys to browse media');
  const thumbs = el('div','gallery-thumbnails'); thumbs.setAttribute('aria-label','Choose media');
  let index = 0, galleryVisible = false;
  const loadActiveTelegram = () => {
    if (!galleryVisible || !root.isConnected) return;
    const slide = track.children[index], embed = slide?.querySelector('.telegram-embed');
    if (!embed || embed.childNodes.length) return;
    if (embed.dataset.failed === 'true') { slide.querySelector('.telegram-load').hidden = false; return; }
    const item = items[index];
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22'; script.async = true;
    script.setAttribute('data-telegram-post', `supernova_plus/${item.post_id}`);
    script.setAttribute('data-width', '100%'); script.setAttribute('data-dark', '1');
    script.setAttribute('data-userpic', 'false');
    script.addEventListener('error', () => {
      embed.replaceChildren(); embed.dataset.failed = 'true';
      slide.querySelector('.telegram-message').textContent = 'Telegram could not load. Retry here or open the source post.';
      slide.querySelector('.telegram-load').hidden = false;
    }, { once: true });
    slide.querySelector('.telegram-load').hidden = true;
    embed.append(script);
  };
  const pause = () => { root.querySelectorAll('video').forEach(video => video.pause()); root.querySelectorAll('.telegram-embed').forEach(embed => embed.replaceChildren()); root.querySelectorAll('.telegram-load').forEach(button => button.hidden=false); };
  const setIndex = value => {
    index = Math.max(0,Math.min(items.length-1,value));
    counter.textContent = `${index+1} / ${items.length} · Source media`;
    previous.disabled = index === 0; next.disabled = index === items.length-1;
    [...thumbs.children].forEach((button,i) => button.setAttribute('aria-pressed',String(i===index)));
    root.querySelectorAll('video').forEach(video => { if (Number(video.dataset.index)!==index) video.pause(); });
    [...track.children].forEach((slide,i) => { if(i!==index){slide.querySelector('.telegram-embed')?.replaceChildren();const load=slide.querySelector('.telegram-load');if(load)load.hidden=true;} });
    loadActiveTelegram();
  };
  const go = value => { setIndex(value); track.scrollTo({left:track.clientWidth*index,behavior:'instant'}); };
  items.forEach((item,i) => {
    const figure = el('figure','gallery-slide'); figure.setAttribute('aria-label',`${i+1} of ${items.length}`);
    if (item.kind === 'image') {
      const button = el('button','gallery-open'), image = el('img'); button.type='button'; button.setAttribute('aria-label',`Enlarge image ${i+1} for ${name}`); image.src=item.src; image.alt=item.caption || `${item.media_verification==='verified'||item.media_verification==='proven'?'Verified':'Unverified'} source image for ${name}, post ${item.post_id}`; image.loading='lazy'; button.append(image); button.addEventListener('click',()=>openLightbox(items,i,name,button)); figure.append(button);
    } else if (item.kind === 'video') {
      const video=el('video'); video.controls=true; video.playsInline=true; video.preload='none'; video.dataset.index=String(i); video.src=item.src; if(item.thumbnail) video.poster=item.thumbnail; video.setAttribute('aria-label',`Unverified source video ${i+1} for ${name}`); figure.append(video);
    } else {
      const poster = el('div', 'gallery-telegram');
      const message = el('p', 'telegram-message', 'Play the video in the Telegram post below.');
      const embed = el('div', 'telegram-embed');
      const action = el('a', 'telegram-source', 'Open on Telegram ↗');
      action.href = item.source_url; action.target = '_blank'; action.rel = 'noopener noreferrer';
      const retry = el('button', 'button telegram-load', 'Retry player'); retry.type = 'button'; retry.hidden = true;
      retry.addEventListener('click', () => { delete embed.dataset.failed; message.textContent = 'Loading Telegram post…'; loadActiveTelegram(); });
      poster.append(message, embed, retry, action); figure.append(poster);
    }
    const caption=el('figcaption'); caption.append(el('span','',`${item.media_verification==='verified'||item.media_verification==='proven'?'Verified':'Unverified'} · `)); const source=el('a','',item.source_label || `Source post ${item.post_id} ↗`);source.href=item.source_url;source.target='_blank';source.rel='noopener noreferrer';caption.append(source);figure.append(caption);track.append(figure);
    const thumb=el('button','gallery-thumb');thumb.type='button';thumb.setAttribute('aria-label',`Show ${item.kind==='image'?'image':'video'} ${i+1}`);if(item.thumbnail){const image=el('img');image.src=item.thumbnail;image.alt='';image.loading='lazy';thumb.append(image);}else thumb.textContent='▶';thumb.addEventListener('click',()=>go(i));thumbs.append(thumb);
  });
  previous.addEventListener('click',()=>go(index-1));next.addEventListener('click',()=>go(index+1));
  track.addEventListener('keydown',event=>{if(event.target.tagName==='VIDEO')return;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();go(index+(event.key==='ArrowRight'?1:-1));}});
  track.addEventListener('scroll',()=>setIndex(Math.round(track.scrollLeft/Math.max(1,track.clientWidth))),{passive:true});
  root.append(toolbar,track,thumbs);setIndex(0);
  // Offscreen or collapsed galleries must not keep a video playing.
  const observer = new IntersectionObserver(entries=>{galleryVisible = entries[0].isIntersecting; if (galleryVisible) loadActiveTelegram(); else pause();}); observer.observe(root);
  const cleanup = new MutationObserver(()=>{if(!root.isConnected){pause();observer.disconnect();cleanup.disconnect();}});cleanup.observe(document.body,{childList:true,subtree:true});
  root.addEventListener('gallery-pause',pause);
  return root;
}
function openLightbox(items, initial, name, trigger) {
  const dialog=el('dialog','media-lightbox');dialog.setAttribute('aria-label',`Source images for ${name}`);
  const images=items.filter(item=>item.kind==='image');let index=images.indexOf(items[initial]);
  const close=el('button','button','Close ✕'), previous=el('button','button','← Previous'), next=el('button','button','Next →'), image=el('img'), label=el('p','gallery-counter'), tools=el('div','gallery-toolbar');
  [close,previous,next].forEach(button=>button.type='button');tools.append(previous,label,next,close);dialog.append(tools,image);
  const show=value=>{index=(value+images.length)%images.length;image.src=images[index].src;const verified=images[index].media_verification==='verified'||images[index].media_verification==='proven';image.alt=images[index].caption||`${verified?'Verified':'Unverified'} source image for ${name}`;label.textContent=`${index+1} / ${images.length} · ${verified?'Verified':'Unverified'}`;previous.disabled=next.disabled=images.length<2;};
  close.addEventListener('click',()=>dialog.close());previous.addEventListener('click',()=>show(index-1));next.addEventListener('click',()=>show(index+1));dialog.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();show(index+(event.key==='ArrowRight'?1:-1));}});dialog.addEventListener('close',()=>{dialog.remove();trigger.focus();},{once:true});document.body.append(dialog);show(index);dialog.showModal();close.focus();
}
