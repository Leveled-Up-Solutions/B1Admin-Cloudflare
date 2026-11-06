import { test, expect, type Page } from "@playwright/test";
async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill('admin@example.test');
  await page.locator('input[type="password"]').fill('LocalDemo2026!');
  const result = page.waitForResponse(r => r.url().endsWith('/api/membership/users/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const data = await (await result).json();
  await expect(page.getByRole('heading', { name: 'Church administration', exact: true })).toBeVisible();
  return data.userChurches[0].jwt as string;
}
test('original household editor moves members, changes roles and creates separate households', async ({page, request}) => {
  const token = await login(page);
  const headers = { Authorization: `Bearer ${token}` };
  const label = `Household${Date.now()}`;
  const householdResponse = await request.post('/api/membership/households', { headers, data: [{name: label}, {name:label+' source'}] });
  expect(householdResponse.ok()).toBeTruthy();
  const [household, source] = await householdResponse.json();
  const created = await request.post('/api/membership/people', {headers, data:[
    {name:{first:label,last:'Parent'}, householdId:household.id, householdRole:'Head'},
    {name:{first:label,last:'Child'}, householdId:household.id, householdRole:'Child'},
    {name:{first:label,last:'Added'}, householdId:source.id, householdRole:'Head'},
  ]}); expect(created.ok()).toBeTruthy(); const people = await created.json();
  const parent = people.find((p: {name: {last: string}}) => p.name.last === 'Parent');
  const added = people.find((p: {name: {last: string}}) => p.name.last === 'Added');
  try {
    await page.getByRole('link', {name:'People', exact:true}).first().click();
    await page.getByLabel('Search people', {exact:true}).fill(label+' Parent');
    await page.getByRole('button', {name:'Search',exact:true}).click();
    await page.getByText(label+' Parent',{exact:true}).first().click();
    await page.locator('#householdBox').getByRole('button', {name:'Edit',exact:true}).click();
    await page.getByTestId('household-name-input').locator('input').fill(label+' Updated');
    await page.getByTestId('household-role-select').first().click();
    await page.getByRole('option', {name:'Spouse',exact:true}).click();
    await page.getByTestId('add-household-member-button').click();
    await page.getByTestId('person-search-input').locator('input').fill(label+' Added');
    await page.getByTestId('search-button').click();
    await page.locator('#householdMemberAddTable').getByRole('button', {name:label+' Added',exact:true}).click();
    await page.locator('#householdBox').getByRole('button',{name:'Save',exact:true}).click();
    await expect(page.getByTestId('household-name-input')).toHaveCount(0);
    await expect(page.locator('#householdBox').getByTitle(label+' Added')).toBeVisible();
    await page.locator('#householdBox').screenshot({path:'test-results/household-review.png'});
    let loaded = await (await request.get('/api/membership/people/'+parent.id,{headers})).json();
    expect(loaded.householdRole).toBe('Spouse');
    expect((await (await request.get('/api/membership/households/'+household.id,{headers})).json()).name).toBe(label+' Updated');
    await page.locator('#householdBox').getByRole('button', {name:'Edit',exact:true}).click();
    const addedRow = page.locator('#householdMemberTable tr').filter({ has: page.getByText(label+' Added', {exact:true}) });
    await addedRow.getByTestId('remove-household-member-button').click();
    await page.locator('#householdBox').getByRole('button',{name:'Save',exact:true}).click();
    await expect(page.getByTestId('household-name-input')).toHaveCount(0);
    loaded = await (await request.get('/api/membership/people/'+added.id,{headers})).json();
    expect(loaded.householdId).not.toBe(household.id); expect(loaded.householdRole).toBe('Head');
  } finally {
    for (const person of people) expect((await request.delete('/api/membership/people/'+person.id,{headers})).ok()).toBeTruthy();
  }
});
test('original advanced directory filters run on D1 without excluded service calls', async ({page, baseURL}) => {
  const failed: string[] = [], external: string[] = [], errors: string[] = [];
  page.on('response', r => {if(r.url().includes('/api/') && r.status()>=400) failed.push(r.status()+' '+r.url());});
  page.on('request', r => {if(!r.url().startsWith(baseURL!) && !r.url().startsWith('data:')) external.push(r.url());});
  page.on('pageerror', e => errors.push(e.message));
  await login(page);
  await page.getByRole('link',{name:'People',exact:true}).first().click();
  await page.getByRole('button',{name:'Advanced search',exact:true}).click();
  const firstName = page.getByRole('checkbox',{name:/^First name$/i});
  if (!(await firstName.isVisible())) await page.getByRole('button',{name:'Names',exact:true}).click();
  await firstName.check();
  const row = firstName.locator('xpath=ancestor::label/..');
  await row.locator('input[type="text"]').fill('Alex');
  await expect(page.getByText('Alex Example',{exact:true}).first()).toBeVisible();
  await expect(page.getByText('Jordan Sample',{exact:true})).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(failed).toEqual([]);expect(external).toEqual([]);expect(errors).toEqual([]);
});
