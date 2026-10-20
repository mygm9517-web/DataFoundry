import { withTemplateStorage } from "../../../../lib/bigscreen-templates-server";
import { NextResponse } from "next/server";
import { readdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import {
  bigScreenUploadRoot,
  readUploadedTemplates,
} from "../../../../lib/bigscreen-templates-server";

/**
 * Cleanup orphaned template files and invalid manifests.
 *
 * This endpoint helps maintain a clean template registry by:
 * 1. Removing folders without valid .template.json
 * 2. Listing templates that exist in filesystem but not in registry
 * 3. Reporting templates that should be unpublished or deleted
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CleanupIssue = {
  type: "orphaned_folder" | "invalid_manifest" | "unpublished_recommended";
  path: string;
  templateId: string;
  reason: string;
  canAutoFix: boolean;
};

async function handleGET(_request: Request): Promise<Response> {
  try {
    const root = bigScreenUploadRoot();
    const issues: CleanupIssue[] = [];

    // Get all template directories
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      return NextResponse.json({
        success: true,
        data: { issues: [], message: "模板目录不存在或为空" },
      });
    }

    // Get registered templates
    const registered = readUploadedTemplates(root);
    const registeredIds = new Set(registered.map((t) => t.id));

    // Check each directory
    for (const dirName of dirs) {
      const dirPath = path.join(root, dirName);
      const manifestPath = path.join(dirPath, ".template.json");

      try {
        statSync(manifestPath);

        // Directory has manifest, check if it's in registry
        if (!registeredIds.has(dirName)) {
          issues.push({
            type: "invalid_manifest",
            path: dirPath,
            templateId: dirName,
            reason: "清单文件存在但模板未在注册表中",
            canAutoFix: false,
          });
        }
      } catch {
        // No manifest file
        issues.push({
          type: "orphaned_folder",
          path: dirPath,
          templateId: dirName,
          reason: "缺少 .template.json 文件",
          canAutoFix: true,
        });
      }
    }

    // Check for templates that are published but might have issues
    for (const template of registered) {
      if (template.published) {
        const dirPath = path.join(root, template.id);
        const entryPath = path.join(dirPath, template.entry);

        try {
          statSync(entryPath);
        } catch {
          issues.push({
            type: "unpublished_recommended",
            path: dirPath,
            templateId: template.id,
            reason: `入口文件 ${template.entry} 不存在`,
            canAutoFix: false,
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        issues,
        totalIssues: issues.length,
        autoFixableCount: issues.filter((i) => i.canAutoFix).length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CLEANUP_CHECK_FAILED",
          message: error instanceof Error ? error.message : "检查失败",
        },
      },
      { status: 500 }
    );
  }
}

async function handlePOST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { autoFix?: boolean };

    if (!body.autoFix) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "需要 autoFix: true 来执行清理",
          },
        },
        { status: 400 }
      );
    }

    const root = bigScreenUploadRoot();
    const removed: string[] = [];

    // Get all template directories
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      return NextResponse.json({
        success: true,
        data: { removed: [], message: "模板目录不存在或为空" },
      });
    }

    // Remove orphaned folders (no .template.json)
    for (const dirName of dirs) {
      const dirPath = path.join(root, dirName);
      const manifestPath = path.join(dirPath, ".template.json");

      try {
        statSync(manifestPath);
      } catch {
        // No manifest, remove the folder
        try {
          rmSync(dirPath, { recursive: true, force: true });
          removed.push(dirName);
        } catch (error) {
          console.error(`Failed to remove ${dirPath}:`, error);
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        removed,
        count: removed.length,
        message: removed.length > 0
          ? `已清理 ${removed.length} 个孤立文件夹`
          : "没有需要清理的文件夹",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CLEANUP_FAILED",
          message: error instanceof Error ? error.message : "清理失败",
        },
      },
      { status: 500 }
    );
  }
}

export const GET = withTemplateStorage(handleGET);
export const POST = withTemplateStorage(handlePOST);
