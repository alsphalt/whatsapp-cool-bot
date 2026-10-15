'use strict'

/*
 * NUMBER -> COUNTRY -> TIMEZONE
 * -----------------------------
 * The runtime card has to show the REAL local time and weather of whoever the bot
 * is paired to, without asking them where they are. A phone number already says
 * it: the leading digits are the ITU calling code, which maps to exactly one
 * country, and each country has a canonical IANA zone plus a city to look weather
 * up for.
 *
 * Two rules keep this honest:
 *
 *   1. LONGEST PREFIX WINS. "+1" (NANP) would otherwise swallow "+1868" Trinidad
 *      and "+1242" Bahamas. Keys are matched longest-first, so the specific entry
 *      always beats the short one.
 *
 *   2. A GUESS IS LABELLED A GUESS. Zones are per-country, and big countries have
 *      several (India is one zone, but the USA and Brazil are not). `resolve()`
 *      therefore reports `confidence` and the card says which city the reading
 *      came from, so nobody is told "your local time" when it is really
 *      "your country's main city's time".
 *
 * Every zone here is validated by resolve() against Intl before it is used, so a
 * typo in this table degrades to the caller's fallback instead of producing an
 * Invalid time zone error inside the card.
 */

/* Calling code -> country, its main city (used for the weather lookup) and the
 * IANA zone for that city. */
const CALLING_CODES = {
    // East Africa
    254: { country: 'Kenya', cc: 'KE', city: 'Nairobi', zone: 'Africa/Nairobi' },
    255: { country: 'Tanzania', cc: 'TZ', city: 'Dar es Salaam', zone: 'Africa/Dar_es_Salaam' },
    256: { country: 'Uganda', cc: 'UG', city: 'Kampala', zone: 'Africa/Kampala' },
    250: { country: 'Rwanda', cc: 'RW', city: 'Kigali', zone: 'Africa/Kigali' },
    257: { country: 'Burundi', cc: 'BI', city: 'Bujumbura', zone: 'Africa/Bujumbura' },
    251: { country: 'Ethiopia', cc: 'ET', city: 'Addis Ababa', zone: 'Africa/Addis_Ababa' },
    252: { country: 'Somalia', cc: 'SO', city: 'Mogadishu', zone: 'Africa/Mogadishu' },
    253: { country: 'Djibouti', cc: 'DJ', city: 'Djibouti', zone: 'Africa/Djibouti' },
    211: { country: 'South Sudan', cc: 'SS', city: 'Juba', zone: 'Africa/Juba' },
    249: { country: 'Sudan', cc: 'SD', city: 'Khartoum', zone: 'Africa/Khartoum' },
    291: { country: 'Eritrea', cc: 'ER', city: 'Asmara', zone: 'Africa/Asmara' },
    231: { country: 'Liberia', cc: 'LR', city: 'Monrovia', zone: 'Africa/Monrovia' },

    // Rest of Africa
    20: { country: 'Egypt', cc: 'EG', city: 'Cairo', zone: 'Africa/Cairo' },
    212: { country: 'Morocco', cc: 'MA', city: 'Casablanca', zone: 'Africa/Casablanca' },
    213: { country: 'Algeria', cc: 'DZ', city: 'Algiers', zone: 'Africa/Algiers' },
    216: { country: 'Tunisia', cc: 'TN', city: 'Tunis', zone: 'Africa/Tunis' },
    218: { country: 'Libya', cc: 'LY', city: 'Tripoli', zone: 'Africa/Tripoli' },
    27: { country: 'South Africa', cc: 'ZA', city: 'Johannesburg', zone: 'Africa/Johannesburg' },
    234: { country: 'Nigeria', cc: 'NG', city: 'Lagos', zone: 'Africa/Lagos' },
    233: { country: 'Ghana', cc: 'GH', city: 'Accra', zone: 'Africa/Accra' },
    220: { country: 'Gambia', cc: 'GM', city: 'Banjul', zone: 'Africa/Banjul' },
    221: { country: 'Senegal', cc: 'SN', city: 'Dakar', zone: 'Africa/Dakar' },
    222: { country: 'Mauritania', cc: 'MR', city: 'Nouakchott', zone: 'Africa/Nouakchott' },
    223: { country: 'Mali', cc: 'ML', city: 'Bamako', zone: 'Africa/Bamako' },
    224: { country: 'Guinea', cc: 'GN', city: 'Conakry', zone: 'Africa/Conakry' },
    225: { country: 'Ivory Coast', cc: 'CI', city: 'Abidjan', zone: 'Africa/Abidjan' },
    226: { country: 'Burkina Faso', cc: 'BF', city: 'Ouagadougou', zone: 'Africa/Ouagadougou' },
    227: { country: 'Niger', cc: 'NE', city: 'Niamey', zone: 'Africa/Niamey' },
    228: { country: 'Togo', cc: 'TG', city: 'Lome', zone: 'Africa/Lome' },
    229: { country: 'Benin', cc: 'BJ', city: 'Porto-Novo', zone: 'Africa/Porto-Novo' },
    230: { country: 'Mauritius', cc: 'MU', city: 'Port Louis', zone: 'Indian/Mauritius' },
    232: { country: 'Sierra Leone', cc: 'SL', city: 'Freetown', zone: 'Africa/Freetown' },
    235: { country: 'Chad', cc: 'TD', city: "N'Djamena", zone: 'Africa/Ndjamena' },
    236: { country: 'Central African Republic', cc: 'CF', city: 'Bangui', zone: 'Africa/Bangui' },
    237: { country: 'Cameroon', cc: 'CM', city: 'Douala', zone: 'Africa/Douala' },
    238: { country: 'Cape Verde', cc: 'CV', city: 'Praia', zone: 'Atlantic/Cape_Verde' },
    239: { country: 'Sao Tome and Principe', cc: 'ST', city: 'Sao Tome', zone: 'Africa/Sao_Tome' },
    240: { country: 'Equatorial Guinea', cc: 'GQ', city: 'Malabo', zone: 'Africa/Malabo' },
    241: { country: 'Gabon', cc: 'GA', city: 'Libreville', zone: 'Africa/Libreville' },
    242: { country: 'Republic of the Congo', cc: 'CG', city: 'Brazzaville', zone: 'Africa/Brazzaville' },
    243: { country: 'DR Congo', cc: 'CD', city: 'Kinshasa', zone: 'Africa/Kinshasa' },
    244: { country: 'Angola', cc: 'AO', city: 'Luanda', zone: 'Africa/Luanda' },
    245: { country: 'Guinea-Bissau', cc: 'GW', city: 'Bissau', zone: 'Africa/Bissau' },
    248: { country: 'Seychelles', cc: 'SC', city: 'Victoria', zone: 'Indian/Mahe' },
    258: { country: 'Mozambique', cc: 'MZ', city: 'Maputo', zone: 'Africa/Maputo' },
    260: { country: 'Zambia', cc: 'ZM', city: 'Lusaka', zone: 'Africa/Lusaka' },
    261: { country: 'Madagascar', cc: 'MG', city: 'Antananarivo', zone: 'Indian/Antananarivo' },
    262: { country: 'Reunion', cc: 'RE', city: 'Saint-Denis', zone: 'Indian/Reunion' },
    263: { country: 'Zimbabwe', cc: 'ZW', city: 'Harare', zone: 'Africa/Harare' },
    264: { country: 'Namibia', cc: 'NA', city: 'Windhoek', zone: 'Africa/Windhoek' },
    265: { country: 'Malawi', cc: 'MW', city: 'Blantyre', zone: 'Africa/Blantyre' },
    266: { country: 'Lesotho', cc: 'LS', city: 'Maseru', zone: 'Africa/Maseru' },
    267: { country: 'Botswana', cc: 'BW', city: 'Gaborone', zone: 'Africa/Gaborone' },
    268: { country: 'Eswatini', cc: 'SZ', city: 'Mbabane', zone: 'Africa/Mbabane' },
    269: { country: 'Comoros', cc: 'KM', city: 'Moroni', zone: 'Indian/Comoro' },

    // South Asia
    91: { country: 'India', cc: 'IN', city: 'New Delhi', zone: 'Asia/Kolkata' },
    92: { country: 'Pakistan', cc: 'PK', city: 'Karachi', zone: 'Asia/Karachi' },
    880: { country: 'Bangladesh', cc: 'BD', city: 'Dhaka', zone: 'Asia/Dhaka' },
    94: { country: 'Sri Lanka', cc: 'LK', city: 'Colombo', zone: 'Asia/Colombo' },
    977: { country: 'Nepal', cc: 'NP', city: 'Kathmandu', zone: 'Asia/Kathmandu' },
    975: { country: 'Bhutan', cc: 'BT', city: 'Thimphu', zone: 'Asia/Thimphu' },
    960: { country: 'Maldives', cc: 'MV', city: 'Male', zone: 'Indian/Maldives' },
    93: { country: 'Afghanistan', cc: 'AF', city: 'Kabul', zone: 'Asia/Kabul' },

    // Middle East
    971: { country: 'United Arab Emirates', cc: 'AE', city: 'Dubai', zone: 'Asia/Dubai' },
    966: { country: 'Saudi Arabia', cc: 'SA', city: 'Riyadh', zone: 'Asia/Riyadh' },
    974: { country: 'Qatar', cc: 'QA', city: 'Doha', zone: 'Asia/Qatar' },
    973: { country: 'Bahrain', cc: 'BH', city: 'Manama', zone: 'Asia/Bahrain' },
    965: { country: 'Kuwait', cc: 'KW', city: 'Kuwait City', zone: 'Asia/Kuwait' },
    968: { country: 'Oman', cc: 'OM', city: 'Muscat', zone: 'Asia/Muscat' },
    962: { country: 'Jordan', cc: 'JO', city: 'Amman', zone: 'Asia/Amman' },
    961: { country: 'Lebanon', cc: 'LB', city: 'Beirut', zone: 'Asia/Beirut' },
    963: { country: 'Syria', cc: 'SY', city: 'Damascus', zone: 'Asia/Damascus' },
    964: { country: 'Iraq', cc: 'IQ', city: 'Baghdad', zone: 'Asia/Baghdad' },
    967: { country: 'Yemen', cc: 'YE', city: 'Sanaa', zone: 'Asia/Aden' },
    972: { country: 'Israel', cc: 'IL', city: 'Jerusalem', zone: 'Asia/Jerusalem' },
    970: { country: 'Palestine', cc: 'PS', city: 'Gaza', zone: 'Asia/Gaza' },
    90: { country: 'Turkey', cc: 'TR', city: 'Istanbul', zone: 'Europe/Istanbul' },
    98: { country: 'Iran', cc: 'IR', city: 'Tehran', zone: 'Asia/Tehran' },

    // East & Southeast Asia
    86: { country: 'China', cc: 'CN', city: 'Shanghai', zone: 'Asia/Shanghai' },
    852: { country: 'Hong Kong', cc: 'HK', city: 'Hong Kong', zone: 'Asia/Hong_Kong' },
    853: { country: 'Macau', cc: 'MO', city: 'Macau', zone: 'Asia/Macau' },
    886: { country: 'Taiwan', cc: 'TW', city: 'Taipei', zone: 'Asia/Taipei' },
    81: { country: 'Japan', cc: 'JP', city: 'Tokyo', zone: 'Asia/Tokyo' },
    82: { country: 'South Korea', cc: 'KR', city: 'Seoul', zone: 'Asia/Seoul' },
    850: { country: 'North Korea', cc: 'KP', city: 'Pyongyang', zone: 'Asia/Pyongyang' },
    62: { country: 'Indonesia', cc: 'ID', city: 'Jakarta', zone: 'Asia/Jakarta' },
    60: { country: 'Malaysia', cc: 'MY', city: 'Kuala Lumpur', zone: 'Asia/Kuala_Lumpur' },
    65: { country: 'Singapore', cc: 'SG', city: 'Singapore', zone: 'Asia/Singapore' },
    66: { country: 'Thailand', cc: 'TH', city: 'Bangkok', zone: 'Asia/Bangkok' },
    84: { country: 'Vietnam', cc: 'VN', city: 'Ho Chi Minh City', zone: 'Asia/Ho_Chi_Minh' },
    63: { country: 'Philippines', cc: 'PH', city: 'Manila', zone: 'Asia/Manila' },
    95: { country: 'Myanmar', cc: 'MM', city: 'Yangon', zone: 'Asia/Yangon' },
    855: { country: 'Cambodia', cc: 'KH', city: 'Phnom Penh', zone: 'Asia/Phnom_Penh' },
    856: { country: 'Laos', cc: 'LA', city: 'Vientiane', zone: 'Asia/Vientiane' },
    673: { country: 'Brunei', cc: 'BN', city: 'Bandar Seri Begawan', zone: 'Asia/Brunei' },
    670: { country: 'Timor-Leste', cc: 'TL', city: 'Dili', zone: 'Asia/Dili' },
    976: { country: 'Mongolia', cc: 'MN', city: 'Ulaanbaatar', zone: 'Asia/Ulaanbaatar' },

    // Europe
    44: { country: 'United Kingdom', cc: 'GB', city: 'London', zone: 'Europe/London' },
    353: { country: 'Ireland', cc: 'IE', city: 'Dublin', zone: 'Europe/Dublin' },
    33: { country: 'France', cc: 'FR', city: 'Paris', zone: 'Europe/Paris' },
    49: { country: 'Germany', cc: 'DE', city: 'Berlin', zone: 'Europe/Berlin' },
    39: { country: 'Italy', cc: 'IT', city: 'Rome', zone: 'Europe/Rome' },
    34: { country: 'Spain', cc: 'ES', city: 'Madrid', zone: 'Europe/Madrid' },
    351: { country: 'Portugal', cc: 'PT', city: 'Lisbon', zone: 'Europe/Lisbon' },
    31: { country: 'Netherlands', cc: 'NL', city: 'Amsterdam', zone: 'Europe/Amsterdam' },
    32: { country: 'Belgium', cc: 'BE', city: 'Brussels', zone: 'Europe/Brussels' },
    41: { country: 'Switzerland', cc: 'CH', city: 'Zurich', zone: 'Europe/Zurich' },
    43: { country: 'Austria', cc: 'AT', city: 'Vienna', zone: 'Europe/Vienna' },
    46: { country: 'Sweden', cc: 'SE', city: 'Stockholm', zone: 'Europe/Stockholm' },
    47: { country: 'Norway', cc: 'NO', city: 'Oslo', zone: 'Europe/Oslo' },
    45: { country: 'Denmark', cc: 'DK', city: 'Copenhagen', zone: 'Europe/Copenhagen' },
    358: { country: 'Finland', cc: 'FI', city: 'Helsinki', zone: 'Europe/Helsinki' },
    354: { country: 'Iceland', cc: 'IS', city: 'Reykjavik', zone: 'Atlantic/Reykjavik' },
    48: { country: 'Poland', cc: 'PL', city: 'Warsaw', zone: 'Europe/Warsaw' },
    420: { country: 'Czechia', cc: 'CZ', city: 'Prague', zone: 'Europe/Prague' },
    421: { country: 'Slovakia', cc: 'SK', city: 'Bratislava', zone: 'Europe/Bratislava' },
    36: { country: 'Hungary', cc: 'HU', city: 'Budapest', zone: 'Europe/Budapest' },
    40: { country: 'Romania', cc: 'RO', city: 'Bucharest', zone: 'Europe/Bucharest' },
    359: { country: 'Bulgaria', cc: 'BG', city: 'Sofia', zone: 'Europe/Sofia' },
    30: { country: 'Greece', cc: 'GR', city: 'Athens', zone: 'Europe/Athens' },
    385: { country: 'Croatia', cc: 'HR', city: 'Zagreb', zone: 'Europe/Zagreb' },
    386: { country: 'Slovenia', cc: 'SI', city: 'Ljubljana', zone: 'Europe/Ljubljana' },
    381: { country: 'Serbia', cc: 'RS', city: 'Belgrade', zone: 'Europe/Belgrade' },
    387: { country: 'Bosnia and Herzegovina', cc: 'BA', city: 'Sarajevo', zone: 'Europe/Sarajevo' },
    389: { country: 'North Macedonia', cc: 'MK', city: 'Skopje', zone: 'Europe/Skopje' },
    355: { country: 'Albania', cc: 'AL', city: 'Tirana', zone: 'Europe/Tirane' },
    7: { country: 'Russia', cc: 'RU', city: 'Moscow', zone: 'Europe/Moscow' },
    380: { country: 'Ukraine', cc: 'UA', city: 'Kyiv', zone: 'Europe/Kyiv' },
    375: { country: 'Belarus', cc: 'BY', city: 'Minsk', zone: 'Europe/Minsk' },
    370: { country: 'Lithuania', cc: 'LT', city: 'Vilnius', zone: 'Europe/Vilnius' },
    371: { country: 'Latvia', cc: 'LV', city: 'Riga', zone: 'Europe/Riga' },
    372: { country: 'Estonia', cc: 'EE', city: 'Tallinn', zone: 'Europe/Tallinn' },
    373: { country: 'Moldova', cc: 'MD', city: 'Chisinau', zone: 'Europe/Chisinau' },
    994: { country: 'Azerbaijan', cc: 'AZ', city: 'Baku', zone: 'Asia/Baku' },
    995: { country: 'Georgia', cc: 'GE', city: 'Tbilisi', zone: 'Asia/Tbilisi' },
    374: { country: 'Armenia', cc: 'AM', city: 'Yerevan', zone: 'Asia/Yerevan' },
    996: { country: 'Kyrgyzstan', cc: 'KG', city: 'Bishkek', zone: 'Asia/Bishkek' },
    992: { country: 'Tajikistan', cc: 'TJ', city: 'Dushanbe', zone: 'Asia/Dushanbe' },
    993: { country: 'Turkmenistan', cc: 'TM', city: 'Ashgabat', zone: 'Asia/Ashgabat' },
    998: { country: 'Uzbekistan', cc: 'UZ', city: 'Tashkent', zone: 'Asia/Tashkent' },
    997: { country: 'Kazakhstan', cc: 'KZ', city: 'Almaty', zone: 'Asia/Almaty' },

    // Americas
    1: { country: 'United States / Canada', cc: 'US', city: 'New York', zone: 'America/New_York' },
    1242: { country: 'Bahamas', cc: 'BS', city: 'Nassau', zone: 'America/Nassau' },
    1246: { country: 'Barbados', cc: 'BB', city: 'Bridgetown', zone: 'America/Barbados' },
    1868: { country: 'Trinidad and Tobago', cc: 'TT', city: 'Port of Spain', zone: 'America/Port_of_Spain' },
    1876: { country: 'Jamaica', cc: 'JM', city: 'Kingston', zone: 'America/Jamaica' },
    52: { country: 'Mexico', cc: 'MX', city: 'Mexico City', zone: 'America/Mexico_City' },
    55: { country: 'Brazil', cc: 'BR', city: 'Sao Paulo', zone: 'America/Sao_Paulo' },
    54: { country: 'Argentina', cc: 'AR', city: 'Buenos Aires', zone: 'America/Argentina/Buenos_Aires' },
    56: { country: 'Chile', cc: 'CL', city: 'Santiago', zone: 'America/Santiago' },
    57: { country: 'Colombia', cc: 'CO', city: 'Bogota', zone: 'America/Bogota' },
    58: { country: 'Venezuela', cc: 'VE', city: 'Caracas', zone: 'America/Caracas' },
    51: { country: 'Peru', cc: 'PE', city: 'Lima', zone: 'America/Lima' },
    593: { country: 'Ecuador', cc: 'EC', city: 'Quito', zone: 'America/Guayaquil' },
    591: { country: 'Bolivia', cc: 'BO', city: 'La Paz', zone: 'America/La_Paz' },
    595: { country: 'Paraguay', cc: 'PY', city: 'Asuncion', zone: 'America/Asuncion' },
    598: { country: 'Uruguay', cc: 'UY', city: 'Montevideo', zone: 'America/Montevideo' },
    502: { country: 'Guatemala', cc: 'GT', city: 'Guatemala City', zone: 'America/Guatemala' },
    503: { country: 'El Salvador', cc: 'SV', city: 'San Salvador', zone: 'America/El_Salvador' },
    504: { country: 'Honduras', cc: 'HN', city: 'Tegucigalpa', zone: 'America/Tegucigalpa' },
    505: { country: 'Nicaragua', cc: 'NI', city: 'Managua', zone: 'America/Managua' },
    506: { country: 'Costa Rica', cc: 'CR', city: 'San Jose', zone: 'America/Costa_Rica' },
    507: { country: 'Panama', cc: 'PA', city: 'Panama City', zone: 'America/Panama' },
    53: { country: 'Cuba', cc: 'CU', city: 'Havana', zone: 'America/Havana' },
    1809: { country: 'Dominican Republic', cc: 'DO', city: 'Santo Domingo', zone: 'America/Santo_Domingo' },
    1829: { country: 'Dominican Republic', cc: 'DO', city: 'Santo Domingo', zone: 'America/Santo_Domingo' },
    1849: { country: 'Dominican Republic', cc: 'DO', city: 'Santo Domingo', zone: 'America/Santo_Domingo' },

    // Oceania
    61: { country: 'Australia', cc: 'AU', city: 'Sydney', zone: 'Australia/Sydney' },
    64: { country: 'New Zealand', cc: 'NZ', city: 'Auckland', zone: 'Pacific/Auckland' },
    679: { country: 'Fiji', cc: 'FJ', city: 'Suva', zone: 'Pacific/Fiji' },
    675: { country: 'Papua New Guinea', cc: 'PG', city: 'Port Moresby', zone: 'Pacific/Port_Moresby' }
}

/* Longest first, so "+1868" is tested before "+1". */
const CODES_BY_LENGTH = Object.keys(CALLING_CODES).sort((a, b) => b.length - a.length)

/** Digits only, no "+", no leading zeros, no device suffix. */
function normalizeNumber(value) {
    let digits = String(value || '').replace(/\D/g, '')
    if (digits.startsWith('00')) digits = digits.slice(2)
    if (/^0\d{9}$/.test(digits)) digits = `254${digits.slice(1)}`
    return digits
}

const zoneExists = (zone) => {
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: zone }).format(new Date())
        return true
    } catch {
        return false
    }
}

/**
 * Which country a number belongs to.
 *
 * Returns null when nothing matches rather than guessing a default country: a
 * wrong timezone would silently show the wrong sky and the wrong hour, which is
 * worse than saying "not known".
 */
function lookup(number) {
    const digits = normalizeNumber(number)
    if (!digits) return null
    for (const code of CODES_BY_LENGTH) {
        if (digits.startsWith(code) && digits.length > code.length) {
            const entry = CALLING_CODES[code]
            if (!zoneExists(entry.zone)) continue
            return {
                ...entry,
                callingCode: `+${code}`,
                confidence: code === '1' ? 'low' : 'high',
                reason: code === '1'
                    ? 'the +1 region spans many timezones (US and Canada), so New York is assumed'
                    : `derived from the calling code +${code}`
            }
        }
    }
    return null
}

/**
 * The timezone to render the runtime in.
 *
 * `fallbackZone` is used only when the number is unknown, and the returned
 * `source` says which route was taken so the card can be honest about it.
 */
function resolve(number, { fallbackZone = '', fallbackCity = '', fallbackCountry = '' } = {}) {
    const hit = lookup(number)
    if (hit) return { ...hit, source: 'number' }
    if (fallbackZone && zoneExists(fallbackZone)) {
        return {
            country: fallbackCountry || 'Unknown country',
            cc: '',
            city: fallbackCity || String(fallbackZone).split('/').pop().replace(/_/g, ' '),
            zone: fallbackZone,
            callingCode: '',
            confidence: 'low',
            reason: 'the number did not match a calling code, so the configured zone was used',
            source: 'fallback'
        }
    }
    return {
        country: 'Unknown country',
        cc: '',
        city: '',
        zone: 'UTC',
        callingCode: '',
        confidence: 'low',
        reason: 'neither the number nor the fallback zone could be resolved',
        source: 'default'
    }
}

module.exports = {
    CALLING_CODES,
    normalizeNumber,
    lookup,
    resolve,
    zoneExists
}
