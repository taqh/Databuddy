import { Marble } from "@usemarble/sdk";
import type { Post } from "@usemarble/sdk/models";
import { NotFoundError } from "@usemarble/sdk/models/errors";
import { notFound } from "next/navigation";
import { cache } from "react";

function createClient(): Marble | undefined {
	const apiKey = process.env.MARBLE_API_KEY?.trim();
	if (!apiKey) {
		return;
	}

	return new Marble({ apiKey });
}

export function isPublished(post: Pick<Post, "publishedAt">): boolean {
	const publishedAt = post.publishedAt.getTime();
	return Number.isFinite(publishedAt) && publishedAt <= Date.now();
}

export const getPosts = cache(async (): Promise<Post[]> => {
	const client = createClient();
	if (!client) {
		return [];
	}

	const pages = await client.posts.list({
		limit: 100,
		order: "desc",
		status: "published",
	});
	const posts: Post[] = [];
	for await (const page of pages) {
		posts.push(...page.result.posts);
	}
	return posts
		.filter(isPublished)
		.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
});

export const getSinglePost = cache(async (slug: string): Promise<Post> => {
	const client = createClient();
	if (!client) {
		notFound();
	}

	let post: Post;
	try {
		({ post } = await client.posts.get({
			identifier: slug,
			status: "published",
		}));
	} catch (error) {
		if (error instanceof NotFoundError) {
			notFound();
		}
		throw error;
	}
	if (!isPublished(post)) {
		notFound();
	}
	return post;
});

export function getPostModifiedAt(
	post: Pick<Post, "publishedAt" | "updatedAt">
): string {
	const { publishedAt, updatedAt } = post;
	return updatedAt.getTime() >= publishedAt.getTime() &&
		updatedAt.getTime() <= Date.now()
		? updatedAt.toISOString()
		: publishedAt.toISOString();
}
