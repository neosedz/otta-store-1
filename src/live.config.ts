// Astro reads live collections from this file, and hands the real
// defineLiveCollection only to it; the EmDash wiring is the store's.
import { defineLiveCollection } from "astro:content";
import { ottaLiveCollections } from "@urumi.ai/otta-store/live-config";

export const collections = ottaLiveCollections(defineLiveCollection);
