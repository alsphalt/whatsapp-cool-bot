'use strict'

/* Protected AntiLink implementation. Runtime string reconstruction plus a
 * compact action dispatcher keeps the sensitive moderation logic out of the
 * main command/event files while preserving the same single event pipeline. */
const fs = require('fs')
const path = require('path')
const { jidNormalizedUser } = require('mzazibaileys')
const cfg = require('../config.json')
const DB = path.join(__dirname, '..', 'database', 'antilink-warnings.json')
const H = (x) => Buffer.from(x, 'hex').toString()
const K = Object.freeze({
  off:H('6f6666'), warn:H('7761726e'), del:H('64656c657465'), kick:H('6b69636b'),
  admin:H('61646d696e'), super:H('737570657261646d696e'), role:H('726f6c65'),
  group:H('40672e7573'), user:H('40732e776869736b6579732e636f6d')
})
const number = (v) => String(v || '').split('@')[0].replace(/\D/g, '')
const same = (a,b) => {
  const x = jidNormalizedUser(String(a || '')), y = jidNormalizedUser(String(b || ''))
  return x === y || (!!number(a) && number(a) === number(b))
}
const isAdmin = (p) => ['admin','superadmin','administrator'].includes(p?.admin || p?.role) || p?.admin === true
/*
 * WHICH IDENTIFIERS A PARTICIPANT CAN CARRY - AND WHY IT MATTERS.
 *
 * This fork returns group members whose `id` is a LID ("123456@lid") while an
 * incoming message carries the sender as a phone JID
 * ("254705472771@s.whatsapp.net"). Matching only id/jid/lid therefore found
 * NOTHING for a genuine admin, which is why `.antilink` answered "Only group
 * admins can configure .antilink." to an actual admin: the lookup failed, not
 * the permission. `phoneNumber` is where that member's phone JID lives in this
 * shape, so it must be part of the test. protected-group.js (.add/.promote)
 * already matches this way, which is why those commands worked and this did not.
 */
const idFields = (p) => [p?.id, p?.jid, p?.lid, p?.phoneNumber, p?.pn, p?.userJid].filter(Boolean)
const participantFor = (meta, who) => {
  if (!who) return null
  const n = number(who)
  return (meta?.participants || []).find(p => idFields(p).some(x => same(x, who) || (n && number(x) === n))) || null
}
/* Member shapes present, for the log only - never for a decision. */
const shapeOf = (meta) => {
  const fields = new Set()
  for (const p of (meta?.participants || []).slice(0, 40)) {
    for (const f of ['id','jid','lid','phoneNumber','pn','userJid']) if (p?.[f]) fields.add(f)
  }
  const sample = (meta?.participants || [])[0]
  return `fields=[${[...fields].join(',') || 'none'}] sampleId=${number(sample?.id) || 'none'} samplePhone=${number(sample?.phoneNumber) || 'none'}`
}

// URLs/domains only: avoids treating ordinary words containing punctuation as links.
const link = (text) => {
  const s = String(text || '')
  if (!s.trim()) return false
  return /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()]+/i.test(s) ||
    /(?:^|[\s(])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|info|biz|me|io|xyz|app|dev|site|online|shop|store|tech|cloud|co\.ke|ke|co\.uk|uk|us|ca|de|fr|in|za|tz|ug|rw)(?:\/[^\s<>()]*)?/i.test(s) ||
    /(?:chat\.whatsapp\.com|wa\.me|t\.me|discord\.gg)\/[^\s<>()]+/i.test(s)
}
function load() {
  try { if (!fs.existsSync(DB)) fs.writeFileSync(DB, '{}'); const x=JSON.parse(fs.readFileSync(DB,'utf8')); return x && typeof x==='object' ? x : {} } catch { return {} }
}
function save(x) {
  const tmp = `${DB}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(x, null, 2))
  fs.renameSync(tmp, DB)
}
const bodyOf = (m) => String(m?.text || m?.message?.conversation || m?.message?.extendedTextMessage?.text || m?.message?.imageMessage?.caption || m?.message?.videoMessage?.caption || m?.message?.documentMessage?.caption || '')
async function handleAntiLink(conn, m) {
  if (!cfg.antilink || cfg.antilink === K.off || !m?.isGroup || m.key?.fromMe) return false
  /*
   * READ THE MESSAGE BEFORE ASKING WHATSAPP ABOUT THE GROUP.
   *
   * This used to fetch groupMetadata first, for EVERY message in every group -
   * stickers, reactions, "ok" - and only then discover that most of them carry
   * no link at all. On a busy group that is several metadata queries a second,
   * which WhatsApp rate-limits; the throttling then hit the ordinary sends too,
   * so the bot looked dead while it was really being punished for asking. The
   * link test is free and local, and it rejects the overwhelming majority.
   */
  const text = bodyOf(m)
  if (!link(text)) return false
  let meta
  try { meta = await conn.groupMetadata(m.chat) } catch (e) { console.error('[ANTILINK] metadata failed:', e?.message || e); return false }
  const sender = m.sender || m.key?.participant
  const participant = participantFor(meta, sender)
  // Never moderate an unresolved sender: this prevents a wrong-user kick/warn.
  if (!participant || isAdmin(participant)) return false
  const canonical = participant.id || participant.jid || participant.phoneNumber || sender
  const bot = participantFor(meta, conn.user?.id)
  const botCanModerate = !!bot && isAdmin(bot)
  const mode = String(cfg.antilink).toLowerCase()

  try { await conn.sendMessage(m.chat, { delete: m.key }) }
  catch (e) { console.error('[ANTILINK] delete failed:', e?.stack || e) }

  let state = 0
  while (state < 4) {
    if (state === 0) { state = mode === K.warn ? 1 : mode === K.kick ? 2 : 3; continue }
    if (state === 1) {
      const db = load(), g = number(m.chat), u = number(canonical)
      db[g] = db[g] && typeof db[g] === 'object' ? db[g] : {}
      const old = Math.max(0, Number(db[g][u] || 0))
      const count = Math.min(4, old + 1)
      db[g][u] = count
      save(db)
      try {
        await conn.sendMessage(m.chat, { text: count >= 4 ? `⚠️ @${number(canonical)} final warning (4/4). You have been removed for repeated link violations.` : `⚠️ @${number(canonical)} warning ${count}/4. Links are not allowed here.`, mentions:[canonical] })
      } catch (e) { console.error('[ANTILINK] warning message failed:', e?.stack || e) }
      if (count >= 4 && botCanModerate && !same(canonical, conn.user?.id)) {
        try { await conn.groupParticipantsUpdate(m.chat, [canonical], 'remove') }
        catch (e) { console.error('[ANTILINK] final-warning kick failed:', e?.stack || e) }
      }
      state = 3; continue
    }
    if (state === 2) {
      if (botCanModerate && !same(canonical, conn.user?.id)) {
        try { await conn.groupParticipantsUpdate(m.chat, [canonical], 'remove') }
        catch (e) { console.error('[ANTILINK] kick failed:', e?.stack || e) }
      } else console.error('[ANTILINK] kick skipped: DARKNOTE is not a group admin')
      state = 3; continue
    }
    state = 4
  }
  return true
}
async function configureAntiLink(conn, m, args, reply) {
  if (!m.isGroup) return reply('❌ This command can only be used in groups.')
  let meta; try { meta = await conn.groupMetadata(m.chat) } catch { return reply('❌ Unable to read this group.') }
  const sender = m.sender || m.key?.participant
  const me = participantFor(meta, sender)
  /*
   * THREE DIFFERENT ANSWERS, because there are three different problems.
   * "Only group admins can configure .antilink" was being sent when the sender
   * could not be matched to a member at all - a lookup failure reported as a
   * permission failure, which sends the operator off checking their admin rights
   * for a bug that has nothing to do with them.
   */
  if (!me) {
    const owner = number(cfg.ownerNumber)
    if (owner && number(sender) === owner) {
      console.log('[ANTILINK] .antilink allowed for the configured owner, who is not listed as a member of this group')
    } else {
      console.error(`[ANTILINK] .antilink refused: sender ${number(sender) || 'unknown'} matched no member - ${shapeOf(meta)}`)
      return reply('❌ I could not match you to a member of this group, so I cannot confirm you are an admin.\n\nPlease try again; if it keeps happening, the member list and the sender use different ID forms (member LID vs phone number).')
    }
  } else if (!isAdmin(me)) {
    return reply('❌ Only group admins can configure .antilink.')
  }
  const mode = String(args?.[0] || '').toLowerCase()
  if (![K.off,K.warn,K.del,K.kick].includes(mode)) return reply(`Usage: ${cfg.prefix || '.'}antilink off|warn|delete|kick\n\nCurrent: ${cfg.antilink || 'off'}`)
  cfg.antilink = mode
  fs.writeFileSync(path.join(__dirname, '..', 'config.json'), JSON.stringify(cfg, null, 2))
  return reply(`✅ AntiLink mode: ${mode.toUpperCase()}.`)
}
module.exports = { handleAntiLink, configureAntiLink, isLikelyLinkMessage: link }
