function _words(text) {
return (text || '')
.toLowerCase()
.replace(/[^a-z0-9\s]/g, ' ')
.split(/\s+/)
.filter(Boolean);
}


function tooFast(qSentAt, now, text) {
const dt = now - qSentAt; // ms
const len = (text || '').length;
// Heuristic: shorter than 1.5s OR longer answer (<5s) is suspicious
if (dt < 1500) return true;
if (len > 180 && dt < 5000) return true;
return false;
}


function copyPasteLikely(qSentAt, now, text) {
const dt = now - qSentAt;
const chars = (text || '').length;
const words = _words(text).length;
// High density input very quickly → likely paste
if (chars > 250 && dt < 4000) return true;
if (words > 60 && dt < 5000) return true;
return false;
}


function jaccard(a, b) {
const A = new Set(_words(a));
const B = new Set(_words(b));
if (A.size === 0 && B.size === 0) return 1;
const inter = new Set([...A].filter(x => B.has(x))).size;
const uni = new Set([...A, ...B]).size;
return inter / uni;
}


function isSimilarToExisting(db, text) {
const baseline = db.sampleRecentAnswers(200);
let best = { hit: false, score: 0, candidateId: null };
for (const row of baseline) {
const s = jaccard(text, row.answer_text || '');
if (s > best.score) best = { hit: s > 0.9, score: s, candidateId: row.candidate_id };
}
return best;
}


module.exports = { tooFast, copyPasteLikely, isSimilarToExisting };