/**
 * Built-in FlowFix AI scenarios: natural-language business requirements bound
 * to real browser journeys on stable public sites.
 *
 * Each scenario carries:
 *  - requirement:   the business requirement in plain English (what is verified)
 *  - url / goal:   what TinyFish executes (execution only)
 *  - expected_outcome: opaque expectation object forwarded VERBATIM to the
 *    verification engine. The backend never interprets it into a verdict.
 *
 * Target sites are deliberately stable and automation-safe:
 *  - scrapeme.live/shop — TinyFish's own docs example shop
 *  - httpbin.org/forms/post — public HTML form that echoes submissions back
 *  - example.com — IANA's permanent illustrative page
 */

export const SCENARIOS = [
  {
    id: 'product-search',
    name: 'E-commerce product search',
    requirement:
      'When a customer searches the shop for "table", the results page must show at least one product matching the search term.',
    url: 'https://scrapeme.live/shop',
    goal: 'Use the shop search to search for "table". Report the names and prices of the products shown in the search results. If no products match, say so explicitly.',
    expected_outcome: {
      type: 'extracted_data_matches',
      field: 'products',
      condition: 'at least one product whose name contains "table" (case-insensitive)',
    },
    // Machine-verifiable checks evaluated by FlowFix's independent verifier
    // against page content it fetches itself — not the agent's self-report.
    checks: [
      {
        key: 'search_results_shown',
        description: 'The search results page lists at least one product matching "table".',
        source: 'page',
        operator: 'contains',
        expected: 'table',
        severity: 'high',
      },
      {
        key: 'product_price_visible',
        description: 'A price is visible next to the matching product.',
        source: 'page',
        operator: 'regex',
        expected: '£[0-9]+',
        severity: 'medium',
      },
    ],
    browserProfile: 'lite',
    captureConfig: { screenshots: true },
  },
  {
    id: 'contact-form',
    name: 'Contact form submission',
    requirement:
      'Submitting the contact form with a name, email and message must echo the submitted values back on the confirmation page.',
    url: 'https://httpbin.org/forms/post',
    goal: 'Fill the order form: customer name "FlowFix Tester", delivery address "1 Test Street", phone "555-0100", email "tester@flowfix.example", set quantity to 2 for the first menu item, add note "FlowFix verification run", then submit the form. Report exactly which values appear in the submitted response.',
    expected_outcome: {
      type: 'form_echo',
      fields: ['customername', 'email', 'deliverto', 'comments'],
      condition: 'submitted values are echoed in the response body',
    },
    checks: [
      {
        key: 'echoed_customer_name',
        description: 'The submitted customer name appears in the confirmation page.',
        source: 'page',
        operator: 'contains',
        expected: 'FlowFix Tester',
        severity: 'high',
      },
      {
        key: 'echoed_email',
        description: 'The submitted email appears in the confirmation page.',
        source: 'page',
        operator: 'contains',
        expected: 'tester@flowfix.example',
        severity: 'high',
      },
      {
        key: 'echoed_comment',
        description: 'The submitted note appears in the confirmation page.',
        source: 'page',
        operator: 'contains',
        expected: 'FlowFix verification run',
        severity: 'medium',
      },
    ],
    browserProfile: 'lite',
    captureConfig: { screenshots: true },
  },
  {
    id: 'content-freshness',
    name: 'Landing page content check',
    requirement:
      'The landing page at example.com must display the headline "Example Domain" and a paragraph mentioning "illustrative".',
    url: 'https://example.com',
    goal: 'Report the main headline (h1) of the page and whether the body text contains the word "illustrative". Quote the headline exactly.',
    expected_outcome: {
      type: 'text_present',
      headline: 'Example Domain',
      keyword: 'illustrative',
      condition: 'headline matches exactly and keyword appears in body text',
    },
    // Observable evidence only: both conditions are checkable against the page
    // itself. If the page cannot be fetched, each check resolves to
    // EVIDENCE_UNREACHABLE and the verdict is INCONCLUSIVE — never PASS.
    checks: [
      {
        key: 'headline_displayed',
        description: 'The page displays the headline "Example Domain".',
        source: 'page',
        operator: 'contains',
        expected: 'Example Domain',
        severity: 'high',
      },
      {
        key: 'illustrative_keyword_present',
        description: 'The body text mentions "illustrative".',
        source: 'page',
        operator: 'contains',
        expected: 'illustrative',
        severity: 'medium',
      },
    ],
    browserProfile: 'lite',
    captureConfig: { screenshots: true },
  },
];

export function getScenario(id) {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

/** Public shape (no internals beyond what the API documents). */
export function scenarioSummaries() {
  return SCENARIOS.map((s) => ({
    id: s.id,
    name: s.name,
    requirement: s.requirement,
    url: s.url,
    goal: s.goal,
    expected_outcome: s.expected_outcome,
    checks: s.checks ?? [],
    browser_profile: s.browserProfile,
  }));
}
