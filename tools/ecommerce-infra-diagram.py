#!/usr/bin/env python3
"""
Writes public/samples/ecommerce-infra-patching-and-rollback.json.

The sample is kept as code rather than as a hand-edited file because it is
large — fifty-odd boxes, seven flows — and most of its value is in the hover
cards and captions, which are easier to keep accurate here than in a panel.
Coordinates are hand-placed; the renderer never moves a box that has them.

Besides writing the file it checks what the editor would not tell you until
you looked: ids are unique, every link joins two things that exist, every flow
hop travels a link that joins where it stands to where it goes, no two boxes
overlap, and no title or subtitle is wider than its box.

    python3 tools/ecommerce-infra-diagram.py            # the sample path
    python3 tools/ecommerce-infra-diagram.py out.json   # somewhere else
"""
import json
import os
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), '..', 'public', 'samples', 'ecommerce-infra-patching-and-rollback.json')

W, H = 250, 46

categories = [
    {"id": "repo", "label": "Repositories", "icon": "📚", "color": "#a3e635"},
    {"id": "pipeline", "label": "Pipelines", "icon": "🚀", "color": "#c084fc"},
    {"id": "security", "label": "Security", "icon": "🔒", "color": "#f59e0b"},
    {"id": "compute", "label": "Services", "icon": "⚙️", "color": "#34d399"},
    {"id": "storage", "label": "Storage", "icon": "📦", "color": "#f472b6"},
    {"id": "edge", "label": "Edge / CDN", "icon": "☁️", "color": "#38bdf8"},
    {"id": "ops", "label": "Ops", "icon": "⏰", "color": "#94a3b8"},
    {"id": "misc", "label": "Other", "icon": "🧩", "color": "#818cf8"},
    # Families this diagram brings with it.
    {"id": "cfn", "label": "CloudFormation", "icon": "🧱", "color": "#60a5fa"},
    {"id": "good", "label": "Succeeded", "icon": "✅", "color": "#4ade80"},
    {"id": "rolled", "label": "Rolled back", "icon": "↩️", "color": "#fbbf24"},
    {"id": "bad", "label": "Failed", "icon": "⛔", "color": "#f87171"},
    {"id": "host", "label": "EC2 hosts", "icon": "🖥️", "color": "#2ec4b6"},
    {"id": "rapid7", "label": "Rapid7", "icon": "🛰️", "color": "#ff8a4c"},
    {"id": "decide", "label": "Decision", "icon": "❓", "color": "#e2e8f0", "shape": "diamond"},
]

groups = [
    {"id": "g_dev", "label": "CDK code · defines AWS resources", "kind": "container", "categoryId": "repo", "icon": "✏️"},
    {"id": "g_pipe", "label": "Devops account", "kind": "container", "categoryId": "pipeline", "icon": "🚀"},
    {"id": "g_env", "label": "Target account · one per environment (dev · qa · prod)", "kind": "container", "categoryId": "edge", "icon": "☁️"},
    {"id": "g_apps", "label": "Apps · each with its own resources", "kind": "container", "categoryId": "compute", "icon": "⚙️", "parentId": "g_env"},
    {"id": "g_ecr", "label": "ECR · images scanned on push", "kind": "container", "categoryId": "storage", "icon": "📦", "parentId": "g_env"},
    {"id": "g_hosts", "label": "EC2 hosts · Rapid7 at boot", "kind": "container", "categoryId": "host", "icon": "🖥️", "parentId": "g_env"},
    {"id": "g_cfn", "label": "CloudFormation", "kind": "container", "categoryId": "cfn", "icon": "🧱"},
    {"id": "g_patch", "label": "How a patch lands", "kind": "container", "categoryId": "ops", "icon": "🩹"},
    {"id": "g_r7", "label": "Rapid7 Insight", "kind": "container", "categoryId": "rapid7", "icon": "🛰️"},
    {"id": "g_base", "label": "Base images · chosen in code", "kind": "container", "categoryId": "repo", "icon": "🧬"},
    {"id": "g_supply", "label": "How EC2 and ECS get their images to run", "kind": "container", "categoryId": "misc", "icon": "📥"},
    {"id": "g_name", "label": "Naming · product-env-type-id", "kind": "container", "categoryId": "rapid7", "icon": "🏷️"},
    {"id": "g_gaps", "label": "Not wired yet", "kind": "container", "categoryId": "security", "icon": "⚠️"},
]

nodes = []


def node(id, label, sub, cat, x, y, group=None, w=W, h=H, **extra):
    n = {"id": id, "label": label, "sublabel": sub, "categoryId": cat, "x": x, "y": y, "width": w, "height": h}
    if group:
        n["groupId"] = group
    n.update(extra)
    nodes.append(n)


# ---- left column: from the code that defines the resources to a deploy ------------------------------
XP = 0
node("n_cfg", "environments.ts + constructs", "one config block per environment", "repo", XP, -52, "g_dev",
     icon="✏️",
     props={
         "file": "src/config/environments.ts",
         "holds": "sizes, AMI generation, Rapid7 flags, image repos",
         "so": "a patch or a toggle is a reviewed one-line diff",
     })
node("n_nag", "cdk-nag · AwsSolutionsChecks", "make test · reported, not a gate", "security", XP, 32, "g_dev",
     icon="🔍",
     props={
         "runs in": "test/nag.test.ts, under jest",
         "reads": "the synthesized template of the whole stack",
         "sees": "every resource the stack creates, for every app",
         "cannot see": "imported resources, or inside a container image",
         "today": "findings are counted per rule; nothing fails on them",
     })
node("n_repo", "Bitbucket · main", "ecommerce-infrastructure · trunk", "repo", XP, 174, "g_pipe",
     type="GitHub::Repository",
     props={"branch": "main, for dev, qa and prod alike"})
node("n_pipe", "CodePipeline · one per env", "EcommerceInfra-dev · -qa · -prod", "pipeline", XP, 258, "g_pipe",
     type="AWS::CodePipeline::Pipeline",
     props={
         "defined in": "src/pipeline-stack.ts",
         "stages": "Source, Approval (prod only), Deploy",
         "independent": "each one is triggered and retried on its own",
     })
node("n_gate", "Manual approval", "prod only", "security", XP, 342, "g_pipe",
     icon="✋",
     props={"dev, qa": "no gate, they deploy on merge"})
node("n_build", "CodeBuild · ecommerce-deploy", "assumes the env's deploy role", "pipeline", XP, 426, "g_pipe",
     icon="🔧",
     props={
         "shared": "one project serves all three pipelines",
         "install": "yarn install --frozen-lockfile",
         "credentials": "auto-refreshing cross-account role profile",
         "timeout": "240 min, long enough to outlast a rollback",
         "on any exit": "prints the stack's FAILED events",
     })
node("n_deploy", "make ci-synth → ci-deploy", "cdk deploy --all --method=direct", "pipeline", XP, 510, "g_pipe",
     icon="🚀",
     props={
         "first": "cdk synth, from src/integ.ts",
         "then": "check the stack status, heal it if wedged",
         "then deploy": "cdk deploy --all --require-approval never",
     })

# ---- where the base images are chosen: in the repo, under the delivery column
node("b_ami", "Host OS · EcsOptimizedImage", "compute.ts · AL2 or AL2023 per env", "host", XP, 652, "g_base",
     icon="🖥️",
     props={
         "where": "src/constructs/compute.ts, on the launch template",
         "library": "CDK's EcsOptimizedImage: AWS's ECS-optimized AMIs",
         "choice": "amazonLinux2023 or amazonLinux2, by the ec2Ami flag",
         "hardware": "AmiHardwareType.STANDARD, x86_64",
         "AMI id": "AWS's recommended one, resolved at each deploy",
         "so": "a newer AWS AMI rolls the hosts on the next deploy",
     })
node("b_from", "Container · Dockerfile FROM", "Docker Hub · symmetricds-pro:3.16.4", "storage", XP, 730, "g_base",
     icon="🐳",
     props={
         "SymmetricDS": "docker/Dockerfile: FROM jumpmind/symmetricds-pro:3.16.4",
         "SQL Server": "xtdbsqlserver/Dockerfile: mssql/server:2022-latest",
         "SQL Server image": "defined, switched off in every environment",
         "pulled by": "cdk deploy in CodeBuild, logged in to Docker Hub",
         "pinned tag": "patched by bumping the version in the Dockerfile",
         "floating tag": "2022-latest can change under any rebuild",
     })
node("b_app", "App images · chosen elsewhere", "in each app's own Dockerfile", "storage", XP, 808, "g_base",
     icon="📦",
     props={
         "images": "liquorcart/magento, magentoagentapi, xtdatatransformer",
         "base image": "set in each app's own repo and pipeline",
         "this stack": "only names the repo and the tag latest",
         "so": "what runs is whatever was pushed last",
     })

# ---- the target account ---------------------------------------------------
XA, XE, XH = 370, 872, 1374
ROWS = [0, 84, 168, 252]

node("a_mag", "Magento · store, admin, REST", "Aurora MySQL · OpenSearch · Redis", "compute", XA, ROWS[0], "g_apps",
     icon="🛒",
     props={
         "ECS services": "MagentoService, MagentoServiceAdmin, MagentoServiceRest",
         "image": "liquorcart/magento:latest",
         "its own": "ALB, WAF, CloudFront, Aurora MySQL, OpenSearch, Redis",
         "deploy": "minHealthy 100%, max 200%, circuit breaker",
     })
node("a_mid", "Middleware · C# agent API", "Aurora PostgreSQL · RabbitMQ", "compute", XA, ROWS[1], "g_apps",
     icon="🔌",
     props={
         "ECS service": "MiddlewareService",
         "containers": "agent + xtdatatransformer",
         "images": "magentoagentapi:latest, xtdatatransformer:latest",
         "its own": "ALB, WAF, Aurora PostgreSQL",
         "RabbitMQ": "Amazon MQ broker, shared with Magento",
         "deploy": "rolling, with no circuit breaker set",
     })
node("a_sym", "SymmetricDS · data sync", "FSx volume · SQL Server XTTDB", "compute", XA, ROWS[2], "g_apps",
     icon="🔄",
     props={
         "ECS service": "SymmetricService",
         "image": "built from ./docker by cdk deploy",
         "its own": "ALB, WAF, FSx volume, SQL Server",
         "deploy": "minHealthy 0%, max 100%, circuit breaker",
     })
node("a_cen", "Central app · Angular SPA", "S3 + CloudFront · no image, no host", "edge", XA, ROWS[3], "g_apps",
     icon="🌎",
     props={
         "its own": "S3 bucket, CloudFront, certificate stack in us-east-1",
         "image": "none",
         "hosts": "none",
         "so": "the template check is the only one that applies",
     })

DW, DH = 140, 84
node("d_img", "Needs an image?", "yes → scan it", "decide", 674, 95, "g_env", w=DW, h=DH, shape="diamond",
     info="Asked of every app the stack deploys.\nNo: nothing to scan. The central app is S3 and CloudFront only.")
node("d_ec2", "Runs on EC2?", "yes → agent", "decide", 1176, 95, "g_env", w=DW, h=DH, shape="diamond",
     info="All three ECS services are placed on the EC2 hosts by the capacity provider.\nNo host, no agent: Rapid7 cannot run on RDS, OpenSearch, ElastiCache or Amazon MQ.")

node("e_mag", "liquorcart/magento", "named repo · findings carry its name", "storage", XE, ROWS[0], "g_ecr",
     type="AWS::ECR::Repository",
     props={
         "referenced by": "Repository.fromRepositoryName",
         "tag": "latest",
         "built by": "the app's own pipeline, not this repo",
     })
node("e_mid", "magentoagentapi", "+ xtdatatransformer · named repos", "storage", XE, ROWS[1], "g_ecr",
     type="AWS::ECR::Repository",
     props={
         "referenced by": "Repository.fromRepositoryName",
         "tag": "latest",
         "built by": "the apps' own pipelines, not this repo",
     })
node("e_sym", "CDK asset repo", "built from ./docker · hash-only tag", "storage", XE, ROWS[2], "g_ecr",
     type="AWS::ECR::Repository",
     props={
         "repo": "cdk-hnb659fds-container-assets-<account>-<region>",
         "tag": "a content hash",
         "holds": "the SymmetricDS image, built during cdk deploy",
         "problem": "a scanner cannot tell which app the image is",
     })
node("e_named", "liquorcart/symmetric · opt-in", "make symmetric-image-push", "storage", XE, ROWS[3], "g_ecr",
     type="AWS::ECR::Repository",
     props={
         "creates the repo with": "scanOnPush=true",
         "then": "set symmetricImageRepo in environments.ts",
         "order": "create the repo, push the tag, then flip the flag",
     })

node("h_lt", "Launch template", "ECS-optimized AMI · AL2 → AL2023", "host", XH, ROWS[0], "g_hosts",
     icon="📋",
     props={
         "per-env flag": "ec2Ami: 'al2' | 'al2023'",
         "dev": "al2023",
         "qa, prod": "al2 until each flips its own flag",
         "user data": "hostname, Rapid7 agent, FSx mounts",
     })
node("h_asg", "ASG1 · rolling update", "1 host per 5 min · min-1 in service", "host", XH, ROWS[1], "g_hosts",
     icon="♻️",
     props={
         "maxBatchSize": 1,
         "pauseTime": "5 minutes",
         "minInstancesInService": "min capacity - 1",
         "tasks": "ECS managed draining moves them off first",
         "without it": "hosts keep the old template forever",
     })
node("h_name", "1 · Unique hostname", "liquorcart-<env>-ec2-asg1-<id8>", "host", XH, ROWS[2], "g_hosts",
     icon="🏷️",
     props={
         "Name tag": "LIQUORCART-<ENV>-EC2-ASG1, shared by the group",
         "hostname": "adds the last 8 characters of the instance id",
         "set": "first in user data, before any agent starts",
         "why": "Rapid7 keys assets on hostname; duplicates merge",
     })
node("h_r7", "2 · Rapid7 Insight Agent", "token read from Secrets Manager", "rapid7", XH, ROWS[3], "g_hosts",
     icon="🛡️",
     props={
         "one agent": "per host, never per task or sidecar",
         "token": "read at boot, never written into user data",
         "install": "yum install the RPM, then configure_agent.sh --token",
         "attributes": "LIQUORCART, <ENV>, EC2-ASG1",
         "if it fails": "logged; the host still joins the cluster",
         "enabled by": "rapid7Enabled + rapid7InstallerUri",
     },
     info="Then the FSx volumes mount and the host joins the ECS cluster.")

# ---- under the hosts: who watches, and what a fix looks like --------------
node("x_r7", "InsightVM · one asset per host", "keyed on the hostname it reports", "rapid7", XH, 446, "g_r7",
     icon="🛰️",
     props={
         "sees": "the host OS underneath the containers",
         "no agent on": "RDS, OpenSearch, ElastiCache, Amazon MQ",
         "containers": "not its job: that is the image scan",
     })
node("x_find", "Finding: Amazon Linux 2 is EOL", "flagged on every container host", "rapid7", XH, 530, "g_r7",
     icon="🚩",
     props={
         "end of standard support": "2025-06-30",
         "fix": "move the hosts to the AL2023 ECS-optimized AMI",
     })

XL, PW = 1058, 252
node("p_img", "Container → rebuild the image", "push, then ECS rolls the service", "storage", XL, 446, "g_patch", w=PW,
     icon="📦",
     props={
         "never": "patch a running task",
         "rollout": "ECS rolling deploy with circuit breaker",
     })
node("p_host", "Host OS → replace the host", "new AMI in the launch template", "host", XL, 530, "g_patch", w=PW,
     icon="🖥️",
     props={
         "never": "yum update on a live host",
         "the change": "ec2Ami in environments.ts",
         "rollout": "ASG1 rolling update, one host every 5 min",
     })
node("p_mgd", "Managed service → AWS patches", "no agent fits · version in config", "ops", XL, 614, "g_patch", w=PW,
     icon="🗄️",
     props={
         "which": "RDS, OpenSearch, ElastiCache, Amazon MQ, FSx",
         "major versions": "set in environments.ts",
         "Rapid7": "authenticated scans only",
     })

# ---- one name per asset, so Rapid7 can tell them apart ---------------------
NW = 278
node("nm_rule", "PRODUCT-ENV-TYPE-ID", "the same four parts for every asset", "rapid7", XH, 670, "g_name", w=NW,
     icon="🏷️",
     props={
         "PRODUCT": "LIQUORCART, so one filter finds the estate",
         "ENV": "DEV, QA or PROD",
         "TYPE": "EC2, ECS, RDS, OS, REDIS, MQ, ALB, FSX",
         "ID": "the role; a suffix only where instances repeat",
         "applied as": "tags and hostnames, never by renaming a resource",
         "helper": "assetName() and assetHost() in src/lib/naming.ts",
     })
node("nm_host", "liquorcart-qa-ec2-asg1-0a1b2c3d", "hostname · agent reports it · live", "host", XH, 738, "g_name", w=NW,
     icon="🖥️",
     props={
         "for": "anything with an OS and an agent",
         "form": "lower case, hyphens only, unique per instance",
         "suffix": "last 8 characters of the instance id",
         "Rapid7": "keys the asset on this name",
         "Name tag": "LIQUORCART-QA-EC2-ASG1, shared by the group",
         "status": "in place",
     })
node("nm_tag", "LIQUORCART-QA-RDS-MYSQL", "Name tag · no-agent assets · proposed", "ops", XH, 806, "g_name", w=NW,
     icon="🗄️",
     props={
         "ECS services": "…-ECS-MAGENTO, -ECS-MIDDLEWARE, -ECS-SYMMETRIC",
         "databases": "…-RDS-MYSQL, -RDS-POSTGRES, -RDS-SQLSERVER",
         "search, cache": "…-OS-MAGENTO, …-REDIS-MAGENTO",
         "broker, storage": "…-MQ-RABBIT, …-FSX-ONTAP",
         "load balancers": "…-ALB-MAGENTO, -ALB-MIDDLEWARE, -ALB-SYMMETRIC",
         "reaches Rapid7": "through an AWS discovery connection",
         "status": "proposed; only the EC2 group is tagged today",
     })
node("nm_img", "liquorcart/symmetric:<tag>", "image repo · env = account · proposed", "storage", XH, 874, "g_name", w=NW,
     type="AWS::ECR::Repository",
     props={
         "form": "product/app, so a finding names its app",
         "ENV": "the account's registry, not the name",
         "repos": "liquorcart/magento, /agent-api, /transformer, /symmetric",
         "today": "magentoagentapi and xtdatatransformer have no prefix",
         "status": "proposed; liquorcart/magento already fits",
     })

# ---- CloudFormation --------------------------------------------------------
C1, C2, CW = 370, 730, 264
CR = [510, 710, 810]
node("c_prog", "UPDATE_IN_PROGRESS", "what changed, in dependency order", "cfn", C1, CR[0], "g_cfn", w=CW,
     icon="⏳",
     props={
         "stack": "ecommerce, one per environment",
         "ECS services": "rolling deploy, each by its own settings",
         "Magento": "never below one healthy task",
         "ASG1": "rolling update, one host at a time",
         "untouched": "anything whose definition did not change",
     })
node("c_ok", "UPDATE_COMPLETE", "old resources removed last", "good", C2, CR[0], "g_cfn", w=CW,
     icon="✅",
     props={
         "cleanup": "replaced resources go only after success",
         "pipeline": "green",
     })
node("s_ecs", "ECS rolls back on its own", "unhealthy → last working version", "rolled", C2, 610, "g_cfn", w=CW,
     icon="🔁",
     props={
         "setting": "circuitBreaker: { rollback: true }",
         "trips when": "new tasks keep failing to start or pass health checks",
         "then": "ECS redeploys the last deployment that completed",
         "Magento": "old tasks keep serving throughout (min healthy 100%)",
         "SymmetricDS": "one task, stopped first: down until the rollback lands",
         "Middleware": "not set: a bad deploy waits for CloudFormation's timeout",
         "after": "the service update fails, so the stack rolls back too",
     })
node("c_rb", "UPDATE_ROLLBACK_IN_PROGRESS", "previous template re-applied", "rolled", C1, CR[1], "g_cfn", w=CW,
     icon="↩️",
     props={
         "trigger": "any resource fails to create or update",
         "ECS": "the service is already back on its last working version",
         "restores": "previous task definition and launch template",
         "nobody": "has to start it: CloudFormation does",
     })
node("c_rbok", "UPDATE_ROLLBACK_COMPLETE", "runs what it ran before · red build", "rolled", C2, CR[1], "g_cfn", w=CW,
     icon="🟡",
     props={
         "environment": "same template as before the deploy",
         "pipeline": "red; its log ends with the failed events",
     },
     info="Careful: a RETAIN resource created during the failed update stays behind.\nIts name is taken, so the next create fails. Import it by name instead.")
node("c_rbfail", "UPDATE_ROLLBACK_FAILED", "wedged: no update is accepted", "bad", C1, CR[2], "g_cfn", w=CW,
     icon="⛔",
     props={
         "meaning": "CloudFormation could not restore a resource",
         "effect": "every later deploy bounces off the stack",
     })
node("c_heal", "cdk rollback --all", "ci-deploy runs it before deploying", "pipeline", C2, CR[2], "g_cfn", w=CW,
     icon="🩹",
     props={
         "where": "Makefile, target ci-deploy",
         "stack busy": "wait for it to settle",
         "stack wedged": "cdk rollback --all, then deploy",
         "permission": "ContinueUpdateRollback on the deploy role",
     })

# ---- how an image reaches what runs: one lane for the host, one for the task
SW, SP, SA, SB = 236, 266, 952, 1040
node("sp_a1", "EC2 · AWS publishes the AMI", "ECS-optimized, patched by AWS", "host", 0, SA, "g_supply", w=SW,
     icon="☁️",
     props={
         "what": "Amazon Linux with Docker and the ECS agent already on it",
         "generation": "AL2 or AL2023, chosen by ec2Ami in environments.ts",
         "we build": "no AMI of our own",
     })
node("sp_a2", "SSM public parameter", "optimized-ami/…/recommended", "host", SP, SA, "g_supply", w=SW,
     icon="🔎",
     props={
         "path": "/aws/service/ecs/optimized-ami/<generation>/recommended/image_id",
         "holds": "the id of AWS's current recommended AMI",
         "moves": "whenever AWS publishes a patched AMI",
     })
node("sp_a3", "Resolved at each deploy", "CloudFormation → launch template", "cfn", SP * 2, SA, "g_supply", w=SW,
     icon="🧱",
     props={
         "how": "the AMI id is a template parameter read from SSM",
         "if it changed": "the launch template gets a new version",
         "then": "ASG1 rolls the hosts, one at a time",
     })
node("sp_a4", "ASG1 launches the instance", "EC2 boots from that AMI", "host", SP * 3, SA, "g_supply", w=SW,
     icon="🖥️",
     props={
         "disk": "40 GB gp3, encrypted",
         "user data": "hostname, Rapid7 agent, FSx mounts",
     })
node("sp_a5", "Host joins the ECS cluster", "after hostname, Rapid7, FSx mounts", "host", SP * 4, SA, "g_supply", w=SW,
     icon="🧊",
     props={
         "who": "the ECS agent that ships in the AMI",
         "cluster": "set in user data by the capacity provider setup",
         "now": "ECS can place tasks on it",
     })
node("sp_b1", "ECS · image built and pushed", "to ECR, by pipeline or cdk deploy", "storage", 0, SB, "g_supply", w=SW,
     icon="🐳",
     props={
         "Magento, agent API, transformer": "built and pushed by each app's own pipeline",
         "SymmetricDS": "built by cdk deploy from ./docker",
         "base": "the FROM line of each Dockerfile",
         "lands in": "ECR in the environment's account, as repo:tag",
         "scan": "on push, where the repo has it switched on",
     })
node("sp_b2", "Task definition names it", "repo:latest, or the asset hash", "compute", SP, SB, "g_supply", w=SW,
     type="AWS::ECS::TaskDefinition",
     props={
         "app images": "ContainerImage.fromEcrRepository(repo, 'latest')",
         "SymmetricDS": "ContainerImage.fromAsset('./docker')",
         "latest": "a new push runs only once the service redeploys",
     })
node("sp_b3", "ECS places a task on a host", "through the capacity provider", "compute", SP * 2, SB, "g_supply", w=SW,
     type="AWS::ECS::Service",
     props={
         "strategy": "the ASG1 capacity provider, weight 100",
         "no room": "managed scaling adds a host first",
     })
node("sp_b4", "ECS agent pulls and runs it", "from ECR, with the execution role", "compute", SP * 3, SB, "g_supply", w=SW,
     icon="▶️",
     props={
         "pull": "the agent on the host fetches repo:tag from ECR",
         "permission": "the task execution role, not the host's own role",
         "then": "the container starts and health checks begin",
     })
node("sp_b5", "Only healthy tasks are used", "ALB routes to healthy targets only", "good", SP * 4, SB, "g_supply", w=SW,
     icon="✅",
     props={
         "load balancer check": "every 40 s; 2 passes to be healthy, 10 fails to be out",
         "paths": "Magento /, Middleware /, SymmetricDS /app",
         "Magento container check": "its FSx mount is present, every 30 s",
         "grace period": "2 minutes after start before failures count",
         "until healthy": "the task gets no traffic",
         "during a deploy": "Magento's old tasks stop only once new ones pass",
         "never healthy": "replaced; repeated failures trip the circuit breaker",
     },
     info="Any answer from 200 to 499 counts as healthy for Magento and SymmetricDS:\nthe check proves the server answers, not that the page is right.")

# ---- what is not wired yet -------------------------------------------------
GW, GH, GY, GP = 250, 50, 1182, 264
node("gap_nag", "cdk-nag does not gate yet", "findings print; the build stays green", "security", 0, GY, "g_gaps",
     w=GW, h=GH, icon="⚠️",
     info="The pack runs under jest and its findings are counted per rule.\nNothing fails on them yet, and the pipeline's buildspec does not run it.")
node("gap_scan", "App repos are imported by name", "their scan settings live elsewhere", "security", GP, GY, "g_gaps",
     w=GW, h=GH, icon="⚠️",
     info="liquorcart/magento, magentoagentapi and xtdatatransformer are looked up, not created.\nThis stack cannot turn scan-on-push on for them, and cdk-nag cannot see inside them.")
node("gap_sym", "Symmetric image is a CDK asset", "symmetricImageRepo unset in every env", "security", GP * 2, GY, "g_gaps",
     w=GW, h=GH, icon="⚠️",
     info="Its findings carry a content hash instead of a name until the image moves to liquorcart/symmetric.")
node("gap_env", "qa and prod hosts still on AL2", "ec2Ami: 'al2023' is set for dev only", "security", GP * 3, GY, "g_gaps",
     w=GW, h=GH, icon="⚠️",
     info="The end-of-life finding stays open in an environment until it flips its own flag.")
node("gap_cb", "Middleware: no circuit breaker", "bad deploys wait for the CFN timeout", "security", GP * 4, GY, "g_gaps",
     w=GW, h=GH, icon="⚠️",
     info="MiddlewareService sets no circuitBreaker, unlike Magento and SymmetricDS.\nA deploy whose tasks never become healthy keeps retrying until CloudFormation's own wait runs out.")

edges = []


def edge(id, a, b, kind="solid", label=None, **extra):
    e = {"id": id, "from": a, "to": b, "kind": kind}
    if label:
        e["label"] = label
    e.update(extra)
    edges.append(e)


edge("e_test", "n_cfg", "n_nag", label="make test")
edge("e_push", "n_nag", "n_repo", label="merge to main")
edge("e_src", "n_repo", "n_pipe", "dashed", label="triggers")
edge("e_gate", "n_pipe", "n_gate")
edge("e_bld", "n_gate", "n_build")
edge("e_mk", "n_build", "n_deploy")
edge("e_upd", "n_deploy", "c_prog", "dashed", label="UpdateStack", speed="fast")

edge("e_apply", "c_prog", "g_env", "dashed", label="updates in place", route="stack")
edge("e_ok", "c_prog", "c_ok", label="all healthy")
edge("e_fail", "c_prog", "c_rb", label="a resource fails")
edge("e_ecs", "c_prog", "s_ecs", label="health checks fail", route="stack")
edge("e_ecsfail", "s_ecs", "c_rb", label="update fails", route="stack")
edge("e_rbok", "c_rb", "c_rbok", label="restored")
edge("e_rbfail", "c_rb", "c_rbfail", "dotted", label="rollback fails too")
edge("e_heal", "c_rbfail", "c_heal", "dashed", label="next deploy")
edge("e_cont", "c_heal", "c_rbok", label="finishes it")

edge("e_q1", "g_apps", "d_img")
edge("e_y1", "d_img", "g_ecr")
edge("e_q2", "g_ecr", "d_ec2")
edge("e_y2", "d_ec2", "g_hosts")
edge("e_optin", "e_sym", "e_named", "dotted", label="move to")

edge("e_h1", "h_lt", "h_asg", label="new version")
edge("e_h2", "h_asg", "h_name", label="each new host")
edge("e_h3", "h_name", "h_r7")
edge("e_enrol", "h_r7", "x_r7", "dashed", label="enrols", speed="fast")
edge("e_find", "x_r7", "x_find")
edge("e_fix", "x_find", "p_host", label="fix")

edge("e_sa1", "sp_a1", "sp_a2")
edge("e_sa2", "sp_a2", "sp_a3")
edge("e_sa3", "sp_a3", "sp_a4")
edge("e_sa4", "sp_a4", "sp_a5")
edge("e_sb1", "sp_b1", "sp_b2")
edge("e_sb2", "sp_b2", "sp_b3")
edge("e_sb3", "sp_b3", "sp_b4")
edge("e_sb4", "sp_b4", "sp_b5")
edge("e_sab", "sp_a5", "sp_b4", "dashed", label="on this host", route="stack")

flows = [
    {
        "id": "fl_deploy",
        "label": "A change ships to an environment",
        "from": "n_cfg",
        "color": "#c084fc",
        "beatMs": 900,
        "restBeats": 3,
        "steps": [
            {"to": "n_nag", "edgeId": "e_test", "label": "Check the template before it is merged",
             "detail": "make test · cdk-nag reads the synthesized stack and reports per rule"},
            {"to": "n_repo", "edgeId": "e_push", "label": "Merge to main",
             "detail": "trunk-based: dev, qa and prod all build from main"},
            {"to": "n_pipe", "edgeId": "e_src", "label": "Each environment has its own pipeline",
             "detail": "EcommerceInfra-dev, -qa and -prod run and retry independently"},
            {"to": "n_gate", "edgeId": "e_gate", "label": "Prod waits for a person",
             "detail": "manual approval · dev and qa go straight through"},
            {"to": "n_build", "edgeId": "e_bld", "label": "One shared CodeBuild project does the work",
             "detail": "it assumes the cross-account deploy role of the target environment"},
            {"to": "n_deploy", "edgeId": "e_mk", "label": "Synthesize, then deploy",
             "detail": "make ci-synth · make ci-deploy · cdk deploy --all --method=direct"},
            {"to": "c_prog", "edgeId": "e_upd", "label": "CloudFormation takes over",
             "detail": "it compares the new template with the running one and changes only what differs"},
            {"to": "g_env", "edgeId": "e_apply", "label": "Each resource updates by its own policy", "beats": 2,
             "detail": "ECS services roll their tasks · ASG1 replaces one host every 5 minutes"},
            {"to": "c_prog", "edgeId": "e_apply", "label": "Only healthy tasks take over",
             "detail": "new tasks get traffic once they pass their checks; only then do the old ones stop"},
            {"to": "c_ok", "edgeId": "e_ok", "label": "UPDATE_COMPLETE",
             "detail": "only now are the replaced resources cleaned up"},
        ],
    },
    {
        "id": "fl_rollback",
        "label": "An update fails and rolls back by itself",
        "from": "n_deploy",
        "color": "#f87171",
        "beatMs": 1200,
        "restBeats": 3,
        "steps": [
            {"to": "c_prog", "edgeId": "e_upd", "label": "A deploy starts like any other",
             "detail": "UpdateStack on the environment's stack"},
            {"to": "g_env", "edgeId": "e_apply", "label": "ECS starts the new tasks",
             "detail": "Magento keeps the old ones serving meanwhile: min healthy 100%, max 200%"},
            {"to": "c_prog", "edgeId": "e_apply", "label": "The new tasks never pass their health checks",
             "detail": "load balancer and container checks, after a 2 minute grace period"},
            {"to": "s_ecs", "edgeId": "e_ecs", "label": "ECS gives up and rolls the service back itself", "beats": 2,
             "detail": "circuit breaker: back to the last deployment that completed, with nobody acting"},
            {"to": "c_rb", "edgeId": "e_ecsfail", "label": "The failed update rolls the stack back too",
             "detail": "CloudFormation puts every resource it touched back to its previous definition"},
            {"to": "c_rbok", "edgeId": "e_rbok", "label": "The environment runs what it ran before",
             "detail": "the build is red and its log ends with the failed events"},
        ],
    },
    {
        "id": "fl_wedged",
        "label": "A rollback gets stuck, and the next deploy heals it",
        "from": "c_rb",
        "color": "#fbbf24",
        "beatMs": 1200,
        "restBeats": 3,
        "steps": [
            {"to": "c_rbfail", "edgeId": "e_rbfail", "label": "The rollback itself fails",
             "detail": "UPDATE_ROLLBACK_FAILED · the stack accepts no further updates"},
            {"to": "c_heal", "edgeId": "e_heal", "label": "The next ci-deploy looks at the stack first",
             "detail": "busy: it waits · wedged: it runs cdk rollback --all before deploying"},
            {"to": "c_rbok", "edgeId": "e_cont", "label": "The rollback is finished for it",
             "detail": "ContinueUpdateRollback, which the deploy role is granted for exactly this"},
        ],
    },
    {
        "id": "fl_rule",
        "label": "Which checks an app gets",
        "from": "g_apps",
        "color": "#34d399",
        "beatMs": 1200,
        "restBeats": 3,
        "steps": [
            {"to": "d_img", "edgeId": "e_q1", "label": "Every app is asked the same two questions",
             "detail": "all of them are already in the template that cdk-nag reads"},
            {"to": "g_ecr", "edgeId": "e_y1", "label": "It needs an image, so the image lives in ECR",
             "detail": "a named repo scanned on push lists its findings per repo and tag"},
            {"to": "e_sym", "label": "One image is still built by CDK during deploy",
             "detail": "SymmetricDS lands in the bootstrap repo under a content hash, with no name"},
            {"to": "e_named", "edgeId": "e_optin", "label": "A named repo makes it attributable",
             "detail": "make symmetric-image-push creates liquorcart/symmetric with scanOnPush=true"},
            {"to": "g_ecr", "label": "A container finding is fixed by rebuilding the image",
             "detail": "push the new tag, and ECS rolls the service onto it"},
            {"to": "d_ec2", "edgeId": "e_q2", "label": "Second question: what does it run on?",
             "detail": "the three ECS services are placed on EC2 hosts by the capacity provider"},
            {"to": "g_hosts", "edgeId": "e_y2", "label": "On our own hosts, so every host carries an agent",
             "detail": "one Rapid7 Insight Agent per host, never per task or as a sidecar"},
            {"to": "h_r7", "label": "Installed at boot, from user data",
             "detail": "the image scan covers the container, the agent covers the OS under it"},
        ],
    },
    {
        "id": "fl_host",
        "label": "A host boots already monitored",
        "from": "h_lt",
        "color": "#ff8a4c",
        "beatMs": 1200,
        "restBeats": 3,
        "steps": [
            {"to": "h_asg", "edgeId": "e_h1", "label": "A new launch template version rolls the group",
             "detail": "one host at a time, 5 minutes apart, after ECS drains its tasks"},
            {"to": "h_name", "edgeId": "e_h2", "label": "First thing at boot: a unique hostname",
             "detail": "liquorcart-<env>-ec2-asg1-<last 8 of the instance id>"},
            {"to": "h_r7", "edgeId": "e_h3", "label": "Then the agent installs and enrols", "beats": 2,
             "detail": "token read from Secrets Manager · yum install · configure_agent.sh --token"},
            {"to": "x_r7", "edgeId": "e_enrol", "label": "The host shows up in Rapid7 by name",
             "detail": "one asset per host, with attributes LIQUORCART, <ENV>, EC2-ASG1"},
            {"to": "x_find", "edgeId": "e_find", "label": "And its findings follow",
             "detail": "for example: Amazon Linux 2 is past end of standard support"},
        ],
    },
    {
        "id": "fl_patch",
        "label": "A finding becomes a patch",
        "from": "x_r7",
        "color": "#38bdf8",
        "beatMs": 900,
        "restBeats": 3,
        "steps": [
            {"to": "x_find", "edgeId": "e_find", "label": "Rapid7 flags the hosts",
             "detail": "Amazon Linux 2 passed end of standard support on 2025-06-30"},
            {"to": "p_host", "edgeId": "e_fix", "label": "Hosts are replaced, never patched in place",
             "detail": "so the fix is a newer AMI in the launch template"},
            {"to": "n_cfg", "label": "Which makes the patch a one-line config change", "beats": 2,
             "detail": "ec2Ami: 'al2023' for that environment, in environments.ts"},
            {"to": "n_nag", "edgeId": "e_test", "label": "It is tested like any other change",
             "detail": "make test"},
            {"to": "n_repo", "edgeId": "e_push", "label": "Merged to main", "detail": ""},
            {"to": "n_pipe", "edgeId": "e_src", "label": "Picked up by that environment's pipeline", "detail": ""},
            {"to": "n_gate", "edgeId": "e_gate", "label": "Approved, if it is prod", "detail": ""},
            {"to": "n_build", "edgeId": "e_bld", "label": "Deployed by CodeBuild", "detail": ""},
            {"to": "n_deploy", "edgeId": "e_mk", "label": "cdk deploy", "detail": ""},
            {"to": "c_prog", "edgeId": "e_upd", "label": "CloudFormation sees a new launch template version",
             "detail": "nothing else in the stack changed, so nothing else is touched"},
            {"to": "g_env", "edgeId": "e_apply", "label": "The update reaches the environment", "detail": ""},
            {"to": "h_lt", "label": "The launch template now names the new AMI", "detail": ""},
            {"to": "h_asg", "edgeId": "e_h1", "label": "ASG1 replaces the hosts one at a time", "beats": 2,
             "detail": "5 minutes apart, keeping min-1 in service; ECS drains tasks off each one first"},
            {"to": "h_name", "edgeId": "e_h2", "label": "Each replacement gets its own hostname", "detail": ""},
            {"to": "h_r7", "edgeId": "e_h3", "label": "And enrols its own agent", "detail": ""},
            {"to": "x_r7", "edgeId": "e_enrol", "label": "Rapid7 sees patched hosts, and the finding closes",
             "detail": "the same path a failed patch would roll back along"},
        ],
    },
    {
        "id": "fl_images",
        "label": "How a host and a task get their images",
        "from": "sp_a1",
        "color": "#818cf8",
        "beatMs": 1200,
        "restBeats": 3,
        "steps": [
            {"to": "sp_a2", "edgeId": "e_sa1", "label": "AWS publishes a patched ECS-optimized AMI",
             "detail": "and points its public SSM parameter at the new image id"},
            {"to": "sp_a3", "edgeId": "e_sa2", "label": "Each deploy reads that parameter",
             "detail": "CloudFormation resolves it into the launch template; a new id is a new version"},
            {"to": "sp_a4", "edgeId": "e_sa3", "label": "ASG1 launches instances from that AMI",
             "detail": "a new version rolls the group, one host at a time"},
            {"to": "sp_a5", "edgeId": "e_sa4", "label": "The host boots and joins the cluster",
             "detail": "user data sets the hostname, installs Rapid7, mounts FSx; the ECS agent registers"},
            {"to": "sp_b1", "label": "The container image takes its own road", "beats": 2,
             "detail": "built on its base image and pushed to ECR, by the app's pipeline or by cdk deploy"},
            {"to": "sp_b2", "edgeId": "e_sb1", "label": "The task definition names that repo and tag",
             "detail": "repo:latest for the app images, a content hash for SymmetricDS"},
            {"to": "sp_b3", "edgeId": "e_sb2", "label": "ECS places the task on a host",
             "detail": "through the ASG1 capacity provider"},
            {"to": "sp_b4", "edgeId": "e_sb3", "label": "The agent on that host pulls the image and starts it",
             "detail": "from ECR, using the task execution role"},
            {"to": "sp_b5", "edgeId": "e_sb4", "label": "It is used only once it is healthy", "beats": 2,
             "detail": "the load balancer sends traffic to targets that pass their checks, and to no others"},
        ],
    },
]

model = {
    "title": "ecommerce-infrastructure · patching, vulnerability monitoring, deploy and rollback",
    "categories": categories,
    "groups": groups,
    "nodes": nodes,
    "edges": edges,
    "net": [],
    "flows": flows,
}

# ---- checks ----------------------------------------------------------------
problems = []
ids = [n["id"] for n in nodes] + [g["id"] for g in groups]
if len(ids) != len(set(ids)):
    problems.append("duplicate ids")
known = set(ids)
cats = {c["id"] for c in categories}
for n in nodes:
    if n["categoryId"] not in cats:
        problems.append(f"{n['id']}: unknown category {n['categoryId']}")
    if n.get("groupId") and n["groupId"] not in known:
        problems.append(f"{n['id']}: unknown group")
    diamond = n.get("shape") == "diamond"
    room = n["width"] * 0.82 if diamond else n["width"] - 36 - 8
    if len(n["label"]) * 6.5 > room:
        problems.append(f"{n['id']}: label may overflow ({len(n['label'])} chars in {n['width']})")
    sub_room = n["width"] * 0.62 if diamond else room
    if len(n.get("sublabel", "")) * 5.4 > sub_room:
        problems.append(f"{n['id']}: sublabel may overflow ({len(n['sublabel'])} chars)")
edge_by_id = {e["id"]: e for e in edges}
if len(edge_by_id) != len(edges):
    problems.append("duplicate edge ids")
for e in edges:
    for end in (e["from"], e["to"]):
        if end not in known:
            problems.append(f"{e['id']}: unknown end {end}")
for f in flows:
    cursor = f["from"]
    if cursor not in known:
        problems.append(f"{f['id']}: unknown start")
    for i, s in enumerate(f["steps"]):
        if s["to"] not in known:
            problems.append(f"{f['id']}[{i}]: unknown target {s['to']}")
        if "edgeId" in s:
            e = edge_by_id.get(s["edgeId"])
            if not e or {e["from"], e["to"]} != {cursor, s["to"]}:
                problems.append(f"{f['id']}[{i}]: {s['edgeId']} does not join {cursor} and {s['to']}")
        cursor = s["to"]

# node overlap
for i, a in enumerate(nodes):
    for b in nodes[i + 1:]:
        if (a["x"] < b["x"] + b["width"] and b["x"] < a["x"] + a["width"]
                and a["y"] < b["y"] + b["height"] and b["y"] < a["y"] + a["height"]):
            problems.append(f"overlap: {a['id']} / {b['id']}")

with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(model, fh, ensure_ascii=False, indent=2)
    fh.write("\n")

print(f"{len(nodes)} nodes, {len(groups)} groups, {len(edges)} edges, {len(flows)} flows -> {OUT}")
for p in problems:
    print("PROBLEM:", p)
sys.exit(1 if problems else 0)
