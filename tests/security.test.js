'use strict'

const fs = require('fs')
const path = require('path')
const security = require('../lib/security')

module.exports = async function securitySuite(harness) {
    harness.section('security engine')
    const configPath = path.join(__dirname, '..', 'config.json')
    const strikePath = path.join(__dirname, '..', 'database', 'anti-strikes.json')
    const originalConfig = fs.readFileSync(configPath)
    const originalStrike = fs.existsSync(strikePath) ? fs.readFileSync(strikePath) : null

    try {
        const calls = []
        const conn = {
            user: { id: '254700000001@s.whatsapp.net' },
            groupMetadata: async () => ({ participants: [{ id: '254700000001@s.whatsapp.net', admin: 'admin' }] }),
            groupParticipantsUpdate: async (group, users, action) => calls.push({ group, users, action }),
            sendMessage: async () => {}
        }

        security.setFeature('antidemote', true)
        security.setEnforcement('kick', true)
        for (let i = 0; i < 3; i++) {
            await security.handleParticipants(conn, {
                id: '120@g.us',
                action: 'demote',
                author: '254700000099@s.whatsapp.net',
                participants: ['254700000088@s.whatsapp.net']
            }, { selfIds: [conn.user.id], isOwner: () => false })
        }

        harness.ok('anti-demote punishes the executor by demotion, not kick',
            calls.some(x => x.action === 'demote' && x.users[0] === '254700000099@s.whatsapp.net') &&
            !calls.some(x => x.action === 'remove'))
    } finally {
        fs.writeFileSync(configPath, originalConfig)
        if (originalStrike) fs.writeFileSync(strikePath, originalStrike)
        else fs.rmSync(strikePath, { force: true })
    }
}
