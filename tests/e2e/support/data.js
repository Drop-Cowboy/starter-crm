// What the fake Drop Cowboy account holds at the start of every test.
// Ids are plain UUIDs, the same form the real API returns. Phone numbers are
// in the 555-01xx fictional range and email domains are reserved example ones.

export const TEAM_ID = '4b8f2c1e-9d3a-4e6f-8a2b-7c5d1e9f3a60';
export const SITE_ID = '7d2a9c4e-1b6f-4a8d-9e3c-5f1b2a7d8c40';
export const STARTER_CRM_USER_ID = 'c3e1f9a2-6d4b-4c8e-b2a7-1f9d3e5c7a20';

export const ADA = {
    contact_id: '1f6c2b9e-3a7d-4e8f-9b1c-2d5e8a7f4c31',
    first_name: 'Ada',
    last_name: 'Lovelace',
    main_phone: '+13125550142',
    email: 'ada@example.com',
    company: 'Analytical Engines',
    has_sms_consent: true,
    created_at: 1786720800000
};

export const GRACE = {
    contact_id: '8a3d5f1c-7e2b-4c9a-8d6e-3b1f7c2a9e52',
    first_name: 'Grace',
    last_name: 'Hopper',
    main_phone: '+13125550143',
    email: 'grace@example.org',
    company: 'Compiler Works',
    has_sms_consent: false,
    created_at: 1788372300000
};

export const KATHERINE = {
    contact_id: '5c9e1a7d-2f4b-4b6e-a3c8-9d7f1e2b5a63',
    first_name: 'Katherine',
    last_name: 'Johnson',
    main_phone: '+13125550144',
    email: 'katherine@example.com',
    company: 'Orbital Math',
    has_sms_consent: true,
    created_at: 1791294000000
};

// DC_E2E_SHOWCASE=1 gives a fuller account, for screenshots. The tests never
// set it, so what they assert on stays as above.
const SHOWCASE = process.env.DC_E2E_SHOWCASE === '1';

const SHOWCASE_CONTACTS = [
    ['2d8f4a1b-6c3e-4f9a-8b2d-1e7c5a9f3b60', 'Hedy', 'Lamarr', '+13125550145', 'hedy@example.com', 'Spread Spectrum Co', 1789000000000, 1250000],
    ['7b1e9c3f-4a2d-4e8b-9f6a-3c5d1b8e2a71', 'Charles', 'Babbage', '+13125550146', 'charles@example.org', 'Difference Engines', 1790500000000, 640000],
    ['4f6a2c8e-1d9b-4a7f-b3e5-8c2a6d4f1b82', 'Claude', 'Shannon', '+13125550147', 'claude@example.com', 'Information Theory Inc', 1787400000000, 980000],
    ['9c3e7a1d-5b8f-4d2a-a6c1-4e9b3f7d2c93', 'Dorothy', 'Vaughan', '+13125550148', 'dorothy@example.com', 'West Computing', 1786100000000, 2100000],
    ['1a5d9f3c-8e2b-4c6a-9d7f-5b1e3a8c4d04', 'Alan', 'Turing', '+13125550149', 'alan@example.org', 'Bombe Logic', 1785200000000, 1575000],
    ['6e2b4d8a-3f7c-4b1e-8a9d-2c6f4e1b7a15', 'Annie', 'Easley', '+13125550150', 'annie@example.com', 'Centaur Rocketry', 1784300000000, 3200000]
].map(([contact_id, first_name, last_name, main_phone, email, company, created_at, deal_value]) => (
    { contact_id, first_name, last_name, main_phone, email, company, has_sms_consent: true, created_at, deal_value }
));

const [HEDY, CHARLES, CLAUDE, DOROTHY, ALAN, ANNIE] = SHOWCASE_CONTACTS.map((c) => c.contact_id);

export const BOARD = {
    board_id: '9e4b7c2a-5d1f-4a3e-8c6b-2f9a1d7e3c84',
    name: 'Sales pipeline',
    stages: SHOWCASE
        ? [
            { list_id: '2b7e9a1c-4d3f-4e5a-9b8c-6a1d3f7e2c95', name: 'New lead', contacts: [ADA.contact_id, HEDY, CHARLES] },
            { list_id: '6d1c3e8a-9b2f-4c7d-a5e1-8f3b2c9d1a06', name: 'Qualified', contacts: [GRACE.contact_id, CLAUDE] },
            { list_id: '8a4f2e6c-1b9d-4c3a-b7e5-9d2f6a1c8e27', name: 'Proposal', contacts: [DOROTHY, ALAN] },
            { list_id: '3c7e1a9f-6d2b-4e8c-a1f4-7b3d9e5c2a38', name: 'Closed won', contacts: [ANNIE] }
        ]
        : [
            { list_id: '2b7e9a1c-4d3f-4e5a-9b8c-6a1d3f7e2c95', name: 'New lead', contacts: [ADA.contact_id] },
            { list_id: '6d1c3e8a-9b2f-4c7d-a5e1-8f3b2c9d1a06', name: 'Qualified', contacts: [GRACE.contact_id] }
        ]
};

export const CONVERSATION = {
    task_id: '3a8f1d6c-2e9b-4d7a-8c5e-1b4f9a3d6e17',
    contact_id: ADA.contact_id,
    task_type: 'sms',
    main_phone: ADA.main_phone,
    caller_id: '+13125550100',
    preview_info: {
        task_contact: 'Ada Lovelace',
        task_content: 'Can we move our call to Thursday?',
        task_date: '2026-10-01T15:04:00.000Z'
    }
};

export const CAMPAIGNS = [
    {
        campaign_id: '0e7a3c9d-1f5b-4a2e-9d8c-4b6f1a3e7c28',
        name: 'October renewals',
        type: 'rvm',
        status: 'running',
        pending_count: 40,
        success_count: 60,
        fail_count: 0
    },
    {
        campaign_id: 'b5d2e8f1-6a3c-4e9b-8f7a-2c1d9e4b6a39',
        name: 'Holiday hours',
        type: 'sms',
        status: 'paused',
        pending_count: 12,
        success_count: 3,
        fail_count: 1
    }
];

export const OWNED_NUMBER = {
    number_id: 'e2c7a4f9-8b1d-4f6e-a9c3-7d5b2e1f8a40',
    phone_number: '+13125550100',
    name: 'Main line',
    sms_enabled: true
};

export const AVAILABLE_NUMBER = {
    phone_number: '+13125550177',
    area_code: '312',
    city: 'Chicago',
    iso_state: 'IL',
    price_cents: 150
};

export const READINESS = {
    embed_ready: false,
    next_actions: ['connect_byoc'],
    building_blocks_enabled: true,
    byoc: { connected: false, providers: [] },
    funds: { available: 25, funds_ok: true },
    numbers: { count: 1 },
    embed_resolve_contact_consent: false
};

export const BUSINESS_NUMBER = OWNED_NUMBER.phone_number;

export function startingContacts() {
    if (!SHOWCASE) {
        return [structuredClone(ADA), structuredClone(GRACE), structuredClone(KATHERINE)];
    }
    const deals = { [ADA.contact_id]: 480000, [GRACE.contact_id]: 1890000 };
    return [ADA, GRACE, KATHERINE].concat(SHOWCASE_CONTACTS)
        .map((c) => Object.assign(structuredClone(c), deals[c.contact_id] ? { deal_value: deals[c.contact_id] } : {}));
}
