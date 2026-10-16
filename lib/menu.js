'use strict'

/* DARKNOTE menu renderer.
 * .menu   = compact bot information/status only
 * .allmenu = complete registered command directory, categorized
 */

const { getRegisteredCommands } = require('./command-system')

const INTERNAL_COMMAND = /^(ytvideo_select(?:_[a-z0-9]+_[0-9]+)?|song_audio(?:_[a-z0-9]+)?|play_card|shazam_(?:audio|play|file|video)(?:_[a-z0-9]+_[0-9]+)?)$/i

const CATEGORIES = [
    { title: 'MAIN', names: ['menu','allmenu','ping','info','owner','cekowner','myjid','public','self','runtime','alive','state','time','weather','contact','tgstatus','tictactoe'] },
    { title: 'AI & CHAT', names: ['ai','aichat','chatbot','autohuman','darknote','ask','aistatus','aisetup','aicapabilities','aihealth','aimodules','aimemory','aimem','aiforget','aireset','aiset','aicap','aidm','aigroup','aityping','aitiming','aireply','aicombine','aiemoji','ainame','aireact','ailanguage','aiassistant','aimoderation','airewrite','aitranslate','aifiles','aiweb','aivision','aiimage','aisticker','aiimagesearch','chatbotdelay','replydelay'] },
    { title: 'GROUP', names: ['tagall','callall','hidetag','listonline','listactive','listinactive','groupadmins','groupadmin','admin','groupjid','channeljid','gpstatus','gppp','kick','kickall','clearance','add','promote','demote','leave','join','approveall','rejectall','creategc','evil_pain'] },
    { title: 'SECURITY', names: ['antilink','antidelete','antidelete1','antidelete2','antidelete3','antidelete4','antiall','anticall','antidemote','antikick','antiadd','antipromote','antisticker','antimedia','antiviewonce','antimentionstatus','antienforce','block','unblock','call'] },
    { title: 'MEDIA', names: ['vv','vv2','vv2auto','conver','ss','sss','getpp','steal','pp','setstatus','setgcpp','avs','als','ars','autoread','autotyping','autorecoding','save','editstatus'] },
    { title: 'AI EDIT', names: ['edit','reedit','editphoto','editsticker'] },
    { title: 'STICKER', names: ['sticker','s','stckcmd'] },
    { title: 'DOWNLOAD', names: ['ytvideo','song','shazam','instagram','ig','igstalk','ytdl','play'] },
    { title: 'OWNER', names: ['addowner','delowner','addprem','delprem','cmdset','setprefix','eval','shell','restart','broadcast','open','close','listgc','outallgrup','joinallgrup'] }
]

const stripArgs = raw => String(raw || '').trim().replace(/^[.!\/#]/, '').split(/[\s<\[(]/)[0].replace(/[^a-z0-9_]/gi, '').toLowerCase()
/*
 * Private AI-family commands: fully functional, deliberately NOT advertised in
 * .menu / .allmenu. They are owner tuning/control switches that are reached for
 * directly, and listing them made the menu disagree with the registry.
 *
 * Both build() and listCommands() route through isInternal(), so teaching it
 * these names fixes the listing AND the reported command count at once, without
 * changing a single command's behaviour.
 */
const PRIVATE_COMMANDS = new Set([
    'chatbot', 'chatbotdelay', 'replydelay', 'darknote', 'ask',
    'statusview', 'statuslike', 'statusreact', 'aisticker', 'aivision'
])

const isInternal = name => INTERNAL_COMMAND.test(String(name || ''))
    || PRIVATE_COMMANDS.has(String(name || '').toLowerCase())

function runtimeText(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0))
    const d = Math.floor(total / 86400)
    const h = Math.floor((total % 86400) / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return `${d}d ${h}h ${m}m ${s}s`
}

function buildInfo(config, info = {}) {
    const prefix = String(config?.prefix || '.')
    const registered = getRegisteredCommands()
    const visible = [...registered].filter(name => !isInternal(name)).length
    const lines = [
        '╭────────────────────────╮',
        '│ ✞  *DARKNOTE*',
        '│   _Connect. Talk. Play._',
        '├────────────────────────┤',
        `│ 🤖 Bot      : ${info.botName || config?.botName || 'DARKNOTE'}`,
        `│ 🏷️ Version  : ${info.version || config?.version || 'L2'}`,
        `│ 📡 Status   : ${info.status || 'CONNECTED'}`,
        `│ 🔐 Mode     : ${info.mode || 'PUBLIC'}`,
        `│ 📱 Number   : ${info.number || '-'}`,
        `│ ⚡ Ping     : ${Number.isFinite(info.ping) ? `${Math.max(0, Math.floor(info.ping))} ms` : '-'}`,
        `│ ⏱️ Runtime  : ${info.runtime || runtimeText(process.uptime())}`,
        `│ 🔧 Prefix   : ${prefix}`,
        `│ 📚 Commands : ${visible}`,
        `│ 🧠 AI       : ${info.ai || 'READY'}`,
        '╰────────────────────────╯',
        '',
        'Use the button below to open the full command directory.'
    ]
    return { text: lines.join('\n'), count: visible, sections: 0 }
}

function build(config, info = {}) {
    const prefix = String(config?.prefix || '.')
    const registered = getRegisteredCommands()
    const shown = new Set()
    const sections = []

    for (const category of CATEGORIES) {
        const lines = []
        for (const raw of category.names) {
            const name = stripArgs(raw)
            if (!name || shown.has(name) || isInternal(name) || !registered.has(name)) continue
            shown.add(name)
            lines.push(`│ ${prefix}${name}`)
        }
        if (lines.length) {
            sections.push([`╭─〔 ${category.title} 〕`, ...lines, '╰────────────────'].join('\n'))
        }
    }

    const rest = [...registered].map(stripArgs)
        .filter(name => name && !shown.has(name) && !isInternal(name))
        .sort()
    if (rest.length) {
        sections.push([`╭─〔 MORE 〕`, ...rest.map(name => `│ ${prefix}${name}`), '╰────────────────'].join('\n'))
    }

    const runtime = info.runtime || runtimeText(process.uptime())
    const header = [
        '╭────────────────────────╮',
        '│ ✞  *DARKNOTE COMMANDS*',
        '├────────────────────────┤',
        `│ 📡 ${info.mode || 'PUBLIC'}  •  ${info.status || 'CONNECTED'}`,
        `│ ⏱️ ${runtime}  •  ⚡ ${Number.isFinite(info.ping) ? `${Math.max(0, Math.floor(info.ping))}ms` : '-'}`,
        `│ 📚 ${shown.size + rest.length} commands`,
        '╰────────────────────────╯'
    ].join('\n')

    return { text: `${header}\n\n${sections.join('\n\n')}`, count: shown.size + rest.length, sections: sections.length }
}

function listCommands() {
    return [...getRegisteredCommands()].map(stripArgs).filter(name => name && !isInternal(name))
}

module.exports = { build, buildInfo, listCommands, stripArgs, isInternal, CATEGORIES, runtimeText }
