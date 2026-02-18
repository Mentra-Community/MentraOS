#!/usr/bin/env bash
#
# Setup UDP LoadBalancer service for a cloud environment
#
# Usage:
#   ./cloud/scripts/setup-udp-service.sh --app cloud-debug --cluster 4689
#   ./cloud/scripts/setup-udp-service.sh --app cloud-prod --cluster 4696
#   ./cloud/scripts/setup-udp-service.sh --app cloud-dev --cluster 4689 --set-env
#   ./cloud/scripts/setup-udp-service.sh --status
#
# See cloud/issues/udp-loadbalancer/ for full documentation

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default values
APP_NAME=""
CLUSTER_ID=""
UDP_PORT=8000
SHOW_STATUS=false
NAMESPACE="default"
SET_PORTER_ENV=false
SET_DOPPLER_ENV=false
SKIP_REDEPLOYS=false
DRY_RUN=false

# Doppler project name
DOPPLER_PROJECT="mentraos-cloud"

get_cluster_name() {
    case $1 in
        4689) echo "US Central" ;;
        4696) echo "France" ;;
        4754) echo "East Asia" ;;
        4753) echo "Canada Central" ;;
        4965) echo "US West" ;;
        4977) echo "US East" ;;
        4978) echo "Australia East" ;;
        *) echo "Unknown" ;;
    esac
}

# Map app+cluster to Doppler config name
get_doppler_config() {
    local app=$1
    local cluster=$2

    case "${app}:${cluster}" in
        "cloud-dev:4689")      echo "dev" ;;
        "cloud-staging:4689")  echo "staging" ;;
        "cloud-prod:4689")     echo "prod_central-us" ;;
        "cloud-prod:4696")     echo "prod_france" ;;
        "cloud-prod:4754")     echo "prod_east-asia" ;;
        "cloud-prod:4977")     echo "prod_us-east" ;;
        "cloud-prod:4965")     echo "prod_us-west" ;;
        "cloud-prod:4753")     echo "prod_canada" ;;
        "cloud-prod:4978")     echo "prod_australia" ;;
        *)                     echo "" ;;  # No Doppler config (e.g., cloud-debug)
    esac
}

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --app <name>        App name (e.g., cloud-debug, cloud-prod)"
    echo "  --cluster <id>      Cluster ID (e.g., 4689, 4696, 4754)"
    echo "  --status            Show status of all UDP services"
    echo "  --set-porter-env    Set UDP_HOST/UDP_PORT in Porter app env vars"
    echo "  --set-doppler-env   Set UDP_HOST/UDP_PORT in Doppler config"
    echo "  --set-env           Set both Porter AND Doppler env vars"
    echo "  --skip-redeploys    Don't trigger app redeploy when setting Porter env"
    echo "  --dry-run           Show what would be done without doing it"
    echo "  --help              Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 --app cloud-debug --cluster 4689"
    echo "  $0 --app cloud-dev --cluster 4689 --set-env"
    echo "  $0 --app cloud-prod --cluster 4696 --set-porter-env --skip-redeploys"
    echo "  $0 --app cloud-prod --cluster 4689 --set-env --dry-run"
    echo "  $0 --status"
    echo ""
    echo "Known clusters:"
    echo "  4689 - US Central (mentra-cluster-central-us)"
    echo "  4696 - France"
    echo "  4754 - East Asia"
    echo "  4753 - Canada Central"
    echo "  4965 - US West"
    echo "  4977 - US East"
    echo "  4978 - Australia East"
    echo ""
    echo "Doppler config mapping:"
    echo "  cloud-dev:4689      → dev"
    echo "  cloud-staging:4689  → staging"
    echo "  cloud-prod:4689     → prod_central-us"
    echo "  cloud-prod:4696     → prod_france"
    echo "  cloud-prod:4754     → prod_east-asia"
    echo "  cloud-prod:4977     → prod_us-east"
    echo "  cloud-prod:4965     → prod_us-west"
    echo "  cloud-prod:4753     → prod_canada"
    echo "  cloud-prod:4978     → prod_australia"
    echo "  cloud-debug:*       → (no Doppler config)"
}

log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

log_dry_run() {
    echo -e "${CYAN}[DRY-RUN]${NC} $1"
}

check_porter() {
    if ! command -v porter &> /dev/null; then
        log_error "Porter CLI not found. Install with: brew install porter-dev/porter/porter"
        exit 1
    fi
}

check_doppler() {
    if ! command -v doppler &> /dev/null; then
        log_error "Doppler CLI not found. Install with: brew install dopplerhq/cli/doppler"
        exit 1
    fi
}

switch_cluster() {
    local cluster_id=$1
    local cluster_name
    cluster_name=$(get_cluster_name "$cluster_id")
    log_info "Switching to cluster $cluster_id ($cluster_name)..."
    porter config set-cluster "$cluster_id" > /dev/null 2>&1
    log_success "Switched to cluster $cluster_id"
}

generate_service_yaml() {
    local app_name=$1
    cat <<EOF
apiVersion: v1
kind: Service
metadata:
  name: ${app_name}-udp
  namespace: ${NAMESPACE}
  labels:
    porter.run/app-name: ${app_name}
    app.kubernetes.io/managed-by: setup-udp-service-script
  annotations:
    description: "UDP LoadBalancer for audio streaming (not managed by Porter)"
spec:
  type: LoadBalancer
  selector:
    porter.run/app-name: ${app_name}
    porter.run/service-name: cloud
  ports:
    - name: udp-audio
      protocol: UDP
      port: ${UDP_PORT}
      targetPort: ${UDP_PORT}
EOF
}

set_porter_env_vars() {
    local app_name=$1
    local cluster_id=$2
    local udp_host=$3

    local skip_flag=""
    if [ "$SKIP_REDEPLOYS" = true ]; then
        skip_flag="--skip-redeploys"
    fi

    if [ "$DRY_RUN" = true ]; then
        log_dry_run "Would run: porter env set --app $app_name --cluster $cluster_id -v UDP_HOST=$udp_host -v UDP_PORT=$UDP_PORT $skip_flag"
        return 0
    fi

    log_info "Setting Porter env vars for $app_name..."

    if porter env set --app "$app_name" --cluster "$cluster_id" -v "UDP_HOST=$udp_host" -v "UDP_PORT=$UDP_PORT" $skip_flag 2>/dev/null; then
        log_success "Porter env vars set: UDP_HOST=$udp_host UDP_PORT=$UDP_PORT"
        if [ "$SKIP_REDEPLOYS" = true ]; then
            log_info "Skipped redeploy (--skip-redeploys)"
        else
            log_info "App will redeploy with new env vars"
        fi
        return 0
    else
        log_error "Failed to set Porter env vars"
        return 1
    fi
}

set_doppler_env_vars() {
    local app_name=$1
    local cluster_id=$2
    local udp_host=$3

    local doppler_config
    doppler_config=$(get_doppler_config "$app_name" "$cluster_id")

    if [ -z "$doppler_config" ]; then
        log_warn "No Doppler config mapping for $app_name:$cluster_id (skipping Doppler)"
        return 0
    fi

    if [ "$DRY_RUN" = true ]; then
        log_dry_run "Would run: doppler secrets set UDP_HOST=$udp_host UDP_PORT=$UDP_PORT --project $DOPPLER_PROJECT --config $doppler_config"
        return 0
    fi

    # Check if Doppler CLI is available
    check_doppler

    log_info "Setting Doppler env vars for config '$doppler_config'..."

    if doppler secrets set "UDP_HOST=$udp_host" "UDP_PORT=$UDP_PORT" --project "$DOPPLER_PROJECT" --config "$doppler_config" > /dev/null 2>&1; then
        log_success "Doppler env vars set: UDP_HOST=$udp_host UDP_PORT=$UDP_PORT (config: $doppler_config)"
        return 0
    else
        log_error "Failed to set Doppler env vars for config '$doppler_config'"
        return 1
    fi
}

apply_service() {
    local app_name=$1

    log_info "Generating UDP service manifest for ${app_name}..."

    # Check if app exists
    if ! porter kubectl -- get pods -l "porter.run/app-name=${app_name}" --no-headers 2>/dev/null | grep -q .; then
        log_error "No pods found for app '${app_name}' in this cluster"
        log_info "Available apps:"
        porter kubectl -- get pods -l "porter.run/app-name" -o jsonpath='{range .items[*]}{.metadata.labels.porter\.run/app-name}{"\n"}{end}' 2>/dev/null | sort -u | head -10
        exit 1
    fi

    if [ "$DRY_RUN" = true ]; then
        log_dry_run "Would apply UDP service manifest:"
        echo "---"
        generate_service_yaml "$app_name"
        echo "---"
        echo ""
        log_dry_run "After IP assignment, would set env vars:"
        if [ "$SET_PORTER_ENV" = true ]; then
            log_dry_run "  porter env set --app $app_name --cluster $CLUSTER_ID -v UDP_HOST=<assigned-ip> -v UDP_PORT=$UDP_PORT $([ "$SKIP_REDEPLOYS" = true ] && echo '--skip-redeploys')"
        fi
        if [ "$SET_DOPPLER_ENV" = true ]; then
            local dc
            dc=$(get_doppler_config "$app_name" "$CLUSTER_ID")
            if [ -n "$dc" ]; then
                log_dry_run "  doppler secrets set UDP_HOST=<assigned-ip> UDP_PORT=$UDP_PORT --project $DOPPLER_PROJECT --config $dc"
            else
                log_dry_run "  (No Doppler config for $app_name:$CLUSTER_ID - would skip)"
            fi
        fi
        return 0
    fi

    log_info "Applying UDP service..."
    generate_service_yaml "$app_name" | porter kubectl -- apply -f - 2>/dev/null
    log_success "Service ${app_name}-udp applied"

    # Wait for IP
    log_info "Waiting for LoadBalancer IP (this may take 30-60 seconds)..."
    local ip=""
    for i in {1..30}; do
        ip=$(porter kubectl -- get svc "${app_name}-udp" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
        if [ -n "$ip" ] && [ "$ip" != "null" ]; then
            break
        fi
        echo -n "."
        sleep 2
    done
    echo ""

    if [ -n "$ip" ] && [ "$ip" != "null" ]; then
        log_success "LoadBalancer IP assigned: ${ip}"
        echo ""
        echo "═══════════════════════════════════════════════════════════"
        echo -e " ${GREEN}UDP Service Ready${NC}"
        echo "═══════════════════════════════════════════════════════════"
        echo ""
        echo "  Service:  ${app_name}-udp"
        echo "  IP:       ${ip}"
        echo "  Port:     ${UDP_PORT}"
        echo "  Endpoint: ${ip}:${UDP_PORT}"
        echo ""
        echo "  Test with:"
        echo "    python3 -c \"import socket,struct; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.sendto(struct.pack('>IH',0x12345678,1)+b'PING',('${ip}',${UDP_PORT}))\""
        echo ""
        echo "  Optional DNS (Cloudflare, DNS-only mode):"
        echo "    udp.{env}.augmentos.cloud → ${ip}"
        echo ""
        echo "═══════════════════════════════════════════════════════════"

        # Set env vars if requested
        if [ "$SET_PORTER_ENV" = true ]; then
            echo ""
            set_porter_env_vars "$app_name" "$CLUSTER_ID" "$ip"
        fi

        if [ "$SET_DOPPLER_ENV" = true ]; then
            echo ""
            set_doppler_env_vars "$app_name" "$CLUSTER_ID" "$ip"
        fi

        # Summary
        if [ "$SET_PORTER_ENV" = true ] || [ "$SET_DOPPLER_ENV" = true ]; then
            echo ""
            echo "═══════════════════════════════════════════════════════════"
            echo -e " ${GREEN}Environment Variables Summary${NC}"
            echo "═══════════════════════════════════════════════════════════"
            if [ "$SET_PORTER_ENV" = true ]; then
                echo "  Porter:  UDP_HOST=${ip} UDP_PORT=${UDP_PORT}"
            fi
            if [ "$SET_DOPPLER_ENV" = true ]; then
                local dc
                dc=$(get_doppler_config "$app_name" "$CLUSTER_ID")
                if [ -n "$dc" ]; then
                    echo "  Doppler: UDP_HOST=${ip} UDP_PORT=${UDP_PORT} (config: ${dc})"
                fi
            fi
            echo "═══════════════════════════════════════════════════════════"
        fi
    else
        log_warn "LoadBalancer IP not yet assigned. Check status with:"
        echo "  porter kubectl -- get svc ${app_name}-udp"
    fi
}

check_env_var_status() {
    local app_name=$1
    local cluster_id=$2

    local porter_status=""
    local doppler_status=""

    # Check Porter
    local porter_udp_host
    porter_udp_host=$(porter env pull --app "$app_name" 2>/dev/null | grep "^UDP_HOST=" | cut -d'=' -f2 || true)
    if [ -n "$porter_udp_host" ]; then
        porter_status="Porter ✓"
    fi

    # Check Doppler
    local doppler_config
    doppler_config=$(get_doppler_config "$app_name" "$cluster_id")
    if [ -n "$doppler_config" ]; then
        local doppler_udp_host
        doppler_udp_host=$(doppler secrets get UDP_HOST --project "$DOPPLER_PROJECT" --config "$doppler_config" --plain 2>/dev/null || true)
        if [ -n "$doppler_udp_host" ]; then
            if [ -n "$porter_status" ]; then
                doppler_status=" Doppler ✓"
            else
                doppler_status="Doppler ✓"
            fi
        fi
    fi

    if [ -n "$porter_status" ] || [ -n "$doppler_status" ]; then
        echo "${porter_status}${doppler_status}"
    else
        echo "-"
    fi
}

show_status() {
    echo ""
    echo "UDP Services Status"
    echo "════════════════════════════════════════════════════════════════════════════════════════"
    printf "%-15s %-8s %-15s %-25s %-20s\n" "APP" "CLUSTER" "REGION" "UDP ENDPOINT" "ENV STATUS"
    echo "────────────────────────────────────────────────────────────────────────────────────────"

    local apps="cloud-debug cloud-dev cloud-staging cloud-prod"

    # Check each cluster
    for cluster_id in 4689 4696 4754 4977 4965 4753 4978; do
        # Switch cluster
        porter config set-cluster "$cluster_id" > /dev/null 2>&1 || continue

        for app in $apps; do
            # Skip non-prod apps on non-main clusters
            if [ "$cluster_id" != "4689" ] && [ "$app" != "cloud-prod" ]; then
                continue
            fi

            # Check if service exists
            local ip
            ip=$(porter kubectl -- get svc "${app}-udp" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
            local region
            region=$(get_cluster_name "$cluster_id")

            if [ -n "$ip" ] && [ "$ip" != "null" ]; then
                local env_status
                env_status=$(check_env_var_status "$app" "$cluster_id")
                printf "%-15s %-8s %-15s ${GREEN}%-25s${NC} %-20s\n" "$app" "$cluster_id" "$region" "${ip}:${UDP_PORT}" "$env_status"
            else
                # Check if app exists at all
                if porter kubectl -- get pods -l "porter.run/app-name=${app}" --no-headers 2>/dev/null | grep -q .; then
                    printf "%-15s %-8s %-15s ${YELLOW}%-25s${NC} %-20s\n" "$app" "$cluster_id" "$region" "(not created)" "-"
                fi
            fi
        done
    done

    echo "════════════════════════════════════════════════════════════════════════════════════════"
    echo ""
    echo "To create a UDP service:"
    echo "  $0 --app <app-name> --cluster <cluster-id>"
    echo ""
    echo "To create and set env vars:"
    echo "  $0 --app <app-name> --cluster <cluster-id> --set-env"
    echo ""
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --app)
            APP_NAME="$2"
            shift 2
            ;;
        --cluster)
            CLUSTER_ID="$2"
            shift 2
            ;;
        --status)
            SHOW_STATUS=true
            shift
            ;;
        --set-porter-env)
            SET_PORTER_ENV=true
            shift
            ;;
        --set-doppler-env)
            SET_DOPPLER_ENV=true
            shift
            ;;
        --set-env)
            SET_PORTER_ENV=true
            SET_DOPPLER_ENV=true
            shift
            ;;
        --skip-redeploys)
            SKIP_REDEPLOYS=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# Main
check_porter

if [ "$SHOW_STATUS" = true ]; then
    show_status
    exit 0
fi

if [ -z "$APP_NAME" ] || [ -z "$CLUSTER_ID" ]; then
    log_error "Both --app and --cluster are required"
    echo ""
    usage
    exit 1
fi

# Validate Doppler is available if needed
if [ "$SET_DOPPLER_ENV" = true ]; then
    check_doppler
fi

if [ "$DRY_RUN" = true ]; then
    echo ""
    log_dry_run "Dry run mode - no changes will be made"
    echo ""
fi

switch_cluster "$CLUSTER_ID"
apply_service "$APP_NAME"
