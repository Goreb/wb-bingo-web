import test from 'node:test';
import assert from 'node:assert/strict';
import {reportMedia, mediaPreview, facilityGalleryMedia, orderedFacilityMedia} from '../gallery.js';
const report = {updates:[{post_id:12,source_url:'https://t.me/supernova_plus/12',photos:[1,2,3].map(i=>({path:`img/reports/photo-${i}.jpg`,sha256:String(i)}))}]};
test('keeps every distinct fallback photo and deduplicates manifest overlap',()=>{
 const media=reportMedia(report,{schema_version:1,by_post:{12:[{kind:'image',src:'img/reports/photo-1.jpg'},{kind:'video',src:'media/reports/video-12.mp4',thumbnail:'img/reports/poster.jpg'}]}});
 assert.equal(media.length,4);assert.equal(media[0].src,'img/reports/photo-1.jpg');assert.equal(mediaPreview(media),'img/reports/photo-1.jpg');
});
test('rejects remote assets, traversal and mismatched post provenance',()=>{
 const entries=[{kind:'image',src:'https://elsewhere.test/image.jpg'},{kind:'image',src:'img/reports/../private.jpg'},{kind:'image',src:'img/reports/valid.jpg',source_url:'https://t.me/supernova_plus/13'},{kind:'video',src:'media/reports/test.mp4?bad'},{kind:'telegram_video',src:'media/reports/a.mp4'}];
 assert.equal(reportMedia({updates:[{...report.updates[0],photos:[]}]},{schema_version:1,by_post:{12:entries}}).length,0);
});
test('unavailable Telegram video is honest external media, not playable local video',()=>{
 const media=reportMedia(report,{schema_version:1,by_post:{12:[{kind:'telegram_video',source_url:'https://t.me/supernova_plus/12',thumbnail:'https://unsafe.test/a.jpg'}]}});
 assert.equal(media[0].kind,'telegram_video');assert.equal(media[0].src,undefined);assert.equal(media[0].thumbnail,null);assert.equal(media[0].media_verification,'unverified');
});
test('optional missing or wrong manifest safely falls back to raw photos',()=>{
 assert.equal(reportMedia(report,null).length,3);assert.equal(reportMedia(report,{schema_version:2}).length,3);
});

test('deduplicates identical media hashes across different local filenames',()=>{
 const sha256='a'.repeat(64);const manifest={schema_version:1,by_post:{12:[{kind:'image',src:'img/reports/a.jpg',sha256},{kind:'image',src:'img/reports/b.jpg',sha256}]}};
 assert.equal(reportMedia({updates:[{...report.updates[0],photos:[]}]},manifest).length,1);
});

test('facility source photos require local assets and HTTPS provenance',()=>{
 const manifest={schema_version:1,facility_photos:{'WB-1':[{kind:'image',src:'img/reports/facility-a.jpg',source_url:'https://operator.test/site'},{kind:'image',src:'img/reports/facility-b.jpg',source_url:'javascript:alert(1)'},{kind:'image',src:'https://operator.test/pic.jpg',source_url:'https://operator.test/site'}]}};
 const media=facilityGalleryMedia(manifest,'WB-1');assert.equal(media.length,1);assert.equal(media[0].source_label,'Source page ↗');assert.equal(facilityGalleryMedia(manifest,'WB-2').length,0);
});

test('incident photos precede operator photos; report approval does not authenticate pixels',()=>{
 const reports=[
  {facility_id:'F1',approval_status:'approved',approval:{scope:'incident_date_town'},updates:[{post_id:12,posted_at:'2026-08-01T10:00:00Z',source_url:'https://t.me/supernova_plus/12',photos:[{path:'img/reports/photo-1.jpg',sha256:'1'}]}]},
  {facility_id:'F1',approval_status:'unapproved',updates:[{post_id:13,posted_at:'2026-08-02T10:00:00Z',source_url:'https://t.me/supernova_plus/13',photos:[{path:'img/reports/photo-2.jpg',sha256:'2'}]}]}
 ];
 const media=orderedFacilityMedia(reports,{schema_version:1,facility_photos:{F1:[{kind:'image',src:'img/reports/facility-a.jpg',source_url:'https://operator.test/photos'}]}},'F1');
 assert.deepEqual(media.map(item=>item.src),['img/reports/photo-1.jpg','img/reports/photo-2.jpg','img/reports/facility-a.jpg']);
 assert.equal(media[0].report_approval_status,'approved');
 assert.equal(media[0].media_verification,'unverified');
});

test('explicit capture dates sort newest first and undated items retain source order',()=>{
 const reports=[{facility_id:'F1',updates:[{post_id:12,posted_at:'2026-08-01T10:00:00Z',source_url:'https://t.me/supernova_plus/12',photos:[{path:'img/reports/photo-1.jpg',sha256:'1'}]},{post_id:13,posted_at:'2026-08-03T10:00:00Z',source_url:'https://t.me/supernova_plus/13',photos:[{path:'img/reports/photo-2.jpg',sha256:'2'}]}]}];
 const manifest={schema_version:1,facility_photos:{F1:[{kind:'image',src:'img/reports/facility-a.jpg',source_url:'https://operator.test/a',captured_at:'2025-01-01'},{kind:'image',src:'img/reports/facility-b.jpg',source_url:'https://operator.test/b',captured_at:'2026-01-01'},{kind:'image',src:'img/reports/facility-c.jpg',source_url:'https://operator.test/c'},{kind:'image',src:'img/reports/facility-d.jpg',source_url:'https://operator.test/d'}]}};
 const media=orderedFacilityMedia(reports,manifest,'F1');
 assert.deepEqual(media.map(item=>item.src),['img/reports/photo-2.jpg','img/reports/photo-1.jpg','img/reports/facility-b.jpg','img/reports/facility-a.jpg','img/reports/facility-c.jpg','img/reports/facility-d.jpg']);
 assert.equal(media[2].captured_at,'2026-01-01');
});

test('deduplication keeps newest occurrence and verified incident media wins',()=>{
 const reports=[
  {facility_id:'F1',updates:[{post_id:12,posted_at:'2026-08-01T10:00:00Z',source_url:'https://t.me/supernova_plus/12',photos:[{path:'img/reports/photo-1.jpg',sha256:'a'.repeat(64)}]}]},
  {facility_id:'F1',updates:[{post_id:13,posted_at:'2026-08-03T10:00:00Z',source_url:'https://t.me/supernova_plus/13',photos:[{path:'img/reports/photo-2.jpg',sha256:'a'.repeat(64)}]}]}
 ];
 const media=orderedFacilityMedia(reports,{schema_version:1,by_post:{12:[{kind:'image',src:'img/reports/photo-1.jpg',sha256:'a'.repeat(64),media_verification:'verified'}]}},'F1');
 assert.equal(media.length,1);assert.equal(media[0].src,'img/reports/photo-1.jpg');assert.equal(media[0].media_verification,'verified');
});

test('operator photos are fallback group and video posters remain usable previews',()=>{
 const reports=[{facility_id:'F1',updates:[{post_id:12,posted_at:'2026-08-01T10:00:00Z',source_url:'https://t.me/supernova_plus/12'}]}];
 const media=orderedFacilityMedia(reports,{schema_version:1,by_post:{12:[{kind:'video',src:'media/reports/video-12.mp4',thumbnail:'img/reports/poster.jpg'}]},facility_photos:{F1:[{kind:'image',src:'img/reports/facility-a.jpg',source_url:'https://operator.test/a'}]}},'F1');
 assert.deepEqual(media.map(item=>item.kind),['video','image']);
 assert.equal(mediaPreview(media),'img/reports/poster.jpg');
});
