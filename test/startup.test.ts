describe("Glossa", function () {
  it("loads the plugin instance", async function () {
    // @ts-expect-error test sandbox
    await assert.waitFor(() => Boolean(Zotero.Glossa?.data?.initialized));
  });
});
