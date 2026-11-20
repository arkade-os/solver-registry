import { rankSolverMarkets, type FetchLike } from "../../src/index.ts";

const fetchAdapter: FetchLike = async () => ({
  ok: true,
  status: 200,
  text: async () => '{"price":"1"}',
});

void rankSolverMarkets([], { network: "bitcoin", fetchImpl: fetchAdapter });
void rankSolverMarkets([], { network: "bitcoin", fetchImpl: fetch });
