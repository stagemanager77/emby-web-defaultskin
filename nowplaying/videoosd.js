﻿define(['playbackManager', 'dom', 'inputmanager', 'datetime', 'itemHelper', 'mediaInfo', 'focusManager', 'imageLoader', 'scrollHelper', 'events', 'connectionManager', 'browser', 'globalize', 'apphost', 'layoutManager', 'userSettings', 'scrollStyles', 'emby-slider', 'paper-icon-button-light'], function (playbackManager, dom, inputManager, datetime, itemHelper, mediaInfo, focusManager, imageLoader, scrollHelper, events, connectionManager, browser, globalize, appHost, layoutManager, userSettings) {
    'use strict';

    function seriesImageUrl(item, options) {

        if (item.Type !== 'Episode') {
            return null;
        }

        options = options || {};
        options.type = options.type || "Primary";

        if (options.type === 'Primary') {

            if (item.SeriesPrimaryImageTag) {

                options.tag = item.SeriesPrimaryImageTag;

                return connectionManager.getApiClient(item.ServerId).getScaledImageUrl(item.SeriesId, options);
            }
        }

        if (options.type === 'Thumb') {

            if (item.SeriesThumbImageTag) {

                options.tag = item.SeriesThumbImageTag;

                return connectionManager.getApiClient(item.ServerId).getScaledImageUrl(item.SeriesId, options);
            }
            if (item.ParentThumbImageTag) {

                options.tag = item.ParentThumbImageTag;

                return connectionManager.getApiClient(item.ServerId).getScaledImageUrl(item.ParentThumbItemId, options);
            }
        }

        return null;
    }

    function imageUrl(item, options) {

        options = options || {};
        options.type = options.type || "Primary";

        if (item.ImageTags && item.ImageTags[options.type]) {

            options.tag = item.ImageTags[options.type];
            return connectionManager.getApiClient(item.ServerId).getScaledImageUrl(item.PrimaryImageItemId || item.Id, options);
        }

        if (options.type === 'Primary') {
            if (item.AlbumId && item.AlbumPrimaryImageTag) {

                options.tag = item.AlbumPrimaryImageTag;
                return connectionManager.getApiClient(item.ServerId).getScaledImageUrl(item.AlbumId, options);
            }
        }

        return null;
    }

    function logoImageUrl(item, apiClient, options) {

        options = options || {};
        options.type = "Logo";

        if (item.ImageTags && item.ImageTags.Logo) {

            options.tag = item.ImageTags.Logo;
            return apiClient.getScaledImageUrl(item.Id, options);
        }

        if (item.ParentLogoImageTag) {
            options.tag = item.ParentLogoImageTag;
            return apiClient.getScaledImageUrl(item.ParentLogoItemId, options);
        }

        return null;
    }

    return function (view, params) {

        var self = this;
        var currentPlayer;
        var currentPlayerSupportedCommands = [];
        var currentRuntimeTicks = 0;
        var comingUpNextDisplayed;
        var currentUpNextDialog;
        var lastUpdateTime = 0;
        var isEnabled;
        var currentItem;
        var recordingButtonManager;
        var enableProgressByTimeOfDay;
        var programStartDateMs = 0;
        var programEndDateMs = 0;
        var playbackStartTimeTicks = 0;

        var nowPlayingVolumeSlider = view.querySelector('.osdVolumeSlider');
        var nowPlayingVolumeSliderContainer = view.querySelector('.osdVolumeSliderContainer');

        var nowPlayingPositionSlider = view.querySelector('.osdPositionSlider');

        var nowPlayingPositionText = view.querySelector('.osdPositionText');
        var nowPlayingDurationText = view.querySelector('.osdDurationText');
        var startTimeText = view.querySelector('.startTimeText');
        var endTimeText = view.querySelector('.endTimeText');
        var endsAtText = view.querySelector('.endsAtText');

        var btnRewind = view.querySelector('.btnRewind');
        var btnFastForward = view.querySelector('.btnFastForward');

        var transitionEndEventName = dom.whichTransitionEvent();

        var headerElement = document.querySelector('.skinHeader');
        var osdBottomElement = document.querySelector('.videoOsdBottom-maincontrols');
        var supportsBrightnessChange;

        var currentVisibleMenu;
        var statsOverlay;

        function onVerticalSwipe(e, elem, data) {
            var player = currentPlayer;
            if (player) {

                var deltaY = data.currentDeltaY;

                var windowSize = dom.getWindowSize();

                if (supportsBrightnessChange && data.clientX < (windowSize.innerWidth / 2)) {
                    doBrightnessTouch(deltaY, player, windowSize.innerHeight);
                    return;
                }
                doVolumeTouch(deltaY, player, windowSize.innerHeight);
            }
        }

        function doBrightnessTouch(deltaY, player, viewHeight) {
            var delta = -((deltaY / viewHeight) * 100);

            var newValue = playbackManager.getBrightness(player) + delta;

            newValue = Math.min(newValue, 100);
            newValue = Math.max(newValue, 0);

            playbackManager.setBrightness(newValue, player);
        }

        function doVolumeTouch(deltaY, player, viewHeight) {

            var delta = -((deltaY / viewHeight) * 100);
            var newValue = playbackManager.getVolume(player) + delta;

            newValue = Math.min(newValue, 100);
            newValue = Math.max(newValue, 0);

            playbackManager.setVolume(newValue, player);
        }

        function initSwipeEvents() {
            require(['touchHelper'], function (TouchHelper) {
                self.touchHelper = new TouchHelper(view, {
                    swipeYThreshold: 30,
                    triggerOnMove: true,
                    preventDefaultOnMove: true,
                    ignoreTagNames: ['BUTTON', 'INPUT', 'TEXTAREA']
                });

                events.on(self.touchHelper, 'swipeup', onVerticalSwipe);
                events.on(self.touchHelper, 'swipedown', onVerticalSwipe);
            });
        }

        function onDoubleClick(e) {

            var clientX = e.clientX;
            if (clientX != null) {

                var windowSize = dom.getWindowSize();

                if (clientX < (windowSize.innerWidth / 2)) {
                    playbackManager.rewind(currentPlayer);
                } else {
                    playbackManager.fastForward(currentPlayer);
                }

                e.preventDefault();
                e.stopPropagation();
            }
        }

        function getDisplayItem(item) {

            if (item.Type === 'TvChannel') {

                var apiClient = connectionManager.getApiClient(item.ServerId);
                return apiClient.getItem(apiClient.getCurrentUserId(), item.Id).then(function (refreshedItem) {

                    return {
                        originalItem: refreshedItem,
                        displayItem: refreshedItem.CurrentProgram
                    };
                });
            }

            return Promise.resolve({
                originalItem: item
            });
        }

        function updateRecordingButton(item) {

            if (item.Type !== 'Program') {

                if (recordingButtonManager) {
                    recordingButtonManager.destroy();
                    recordingButtonManager = null;
                }
                view.querySelector('.btnRecord').classList.add('hide');
                return;
            }

            if (recordingButtonManager) {
                recordingButtonManager.refreshItem(item);
                return;
            }

            connectionManager.getApiClient(item.ServerId).getCurrentUser().then(function (user) {

                if (!user.Policy.EnableLiveTvManagement) {
                    return;
                }

                require(['recordingButton'], function (RecordingButton) {

                    recordingButtonManager = new RecordingButton({
                        item: item,
                        button: view.querySelector('.btnRecord')
                    });

                    view.querySelector('.btnRecord').classList.remove('hide');
                });
            });
        }

        function updateDisplayItem(itemInfo) {

            var item = itemInfo.originalItem;
            currentItem = item;
            var displayItem = itemInfo.displayItem || item;

            updateRecordingButton(displayItem);
            setPoster(displayItem, item);

            var parentName = displayItem.SeriesName || displayItem.Album;

            if (displayItem.EpisodeTitle || displayItem.IsSeries) {
                parentName = displayItem.Name;
            }

            setTitle(displayItem, parentName);

            var osdTitle = view.querySelector('.osdTitle');
            var titleElement;

            titleElement = osdTitle;

            // Don't use this for live tv programs because this is contained in mediaInfo.getPrimaryMediaInfoHtml
            var displayName = itemHelper.getDisplayName(displayItem, {
                includeParentInfo: displayItem.Type !== 'Program',
                includeIndexNumber: displayItem.Type !== 'Program'
            });

            // Use the series name if there is no episode info
            if (!displayName && displayItem.Type === 'Program') {
                //displayName = displayItem.Name;
            }

            titleElement.innerHTML = displayName;

            if (displayName) {
                titleElement.classList.remove('hide');
            } else {
                titleElement.classList.add('hide');
            }

            var mediaInfoHtml = mediaInfo.getPrimaryMediaInfoHtml(displayItem, {
                runtime: false,
                subtitles: false,
                tomatoes: false,
                endsAt: false,
                episodeTitle: false,
                originalAirDate: displayItem.Type !== 'Program',
                episodeTitleIndexNumber: displayItem.Type !== 'Program',
                programIndicator: false
            });

            var osdMediaInfo = view.querySelector('.osdMediaInfo');
            osdMediaInfo.innerHTML = mediaInfoHtml;

            if (mediaInfoHtml) {
                osdMediaInfo.classList.remove('hide');
            } else {
                osdMediaInfo.classList.add('hide');
            }

            var secondaryMediaInfo = view.querySelector('.osdSecondaryMediaInfo');
            var secondaryMediaInfoHtml = mediaInfo.getSecondaryMediaInfoHtml(displayItem, {
                startDate: false,
                programTime: false
            });
            secondaryMediaInfo.innerHTML = secondaryMediaInfoHtml;

            if (secondaryMediaInfoHtml) {
                secondaryMediaInfo.classList.remove('hide');
            } else {
                secondaryMediaInfo.classList.add('hide');
            }

            if (displayName) {
                view.querySelector('.osdMainTextContainer').classList.remove('hide');
            } else {
                view.querySelector('.osdMainTextContainer').classList.add('hide');
            }

            if (enableProgressByTimeOfDay) {

                setDisplayTime(startTimeText, displayItem.StartDate);
                setDisplayTime(endTimeText, displayItem.EndDate);

                startTimeText.classList.remove('hide');
                endTimeText.classList.remove('hide');

                programStartDateMs = displayItem.StartDate ? datetime.parseISO8601Date(displayItem.StartDate).getTime() : 0;
                programEndDateMs = displayItem.EndDate ? datetime.parseISO8601Date(displayItem.EndDate).getTime() : 0;

            } else {
                startTimeText.classList.add('hide');
                endTimeText.classList.add('hide');

                startTimeText.innerHTML = '';
                endTimeText.innerHTML = '';

                programStartDateMs = 0;
                programEndDateMs = 0;
            }
        }

        function getDisplayTimeWithoutAmPm(date, showSeconds) {

            if (showSeconds) {
                return datetime.toLocaleTimeString(date, {

                    hour: 'numeric',
                    minute: '2-digit',
                    second: '2-digit'

                }).toLowerCase().replace('am', '').replace('pm', '').trim();
            }

            return datetime.getDisplayTime(date).toLowerCase().replace('am', '').replace('pm', '').trim();
        }

        function setDisplayTime(elem, date) {

            var html;

            if (date) {
                date = datetime.parseISO8601Date(date);

                html = getDisplayTimeWithoutAmPm(date);
            }

            elem.innerHTML = html || '';
        }

        function shouldEnableProgressByTimeOfDay(item) {

            if (item.Type === 'TvChannel' && item.CurrentProgram) {
                return true;
            }

            //if (item.Type === 'Recording' && item.StartDate && item.EndDate) {

            //    var endDate = datetime.parseISO8601Date(item.EndDate).getTime();
            //    var startDate = datetime.parseISO8601Date(item.StartDate).getTime();
            //    var now = new Date().getTime();

            //    if (now <= endDate && now >= startDate) {
            //        return true;
            //    }
            //}

            return false;
        }

        function updateNowPlayingInfo(player, state) {

            var item = state.NowPlayingItem;
            currentItem = item;

            if (!item) {
                setPoster(null);
                Emby.Page.setTitle('');
                nowPlayingVolumeSlider.disabled = true;
                nowPlayingPositionSlider.disabled = true;
                btnFastForward.disabled = true;
                btnRewind.disabled = true;

                view.querySelector('.btnSubtitles').classList.add('hide');
                view.querySelector('.btnAudio').classList.add('hide');

                view.querySelector('.osdTitle').innerHTML = '';
                view.querySelector('.osdMediaInfo').innerHTML = '';
                return;
            }

            enableProgressByTimeOfDay = shouldEnableProgressByTimeOfDay(item);
            getDisplayItem(item).then(updateDisplayItem);

            nowPlayingVolumeSlider.disabled = false;
            nowPlayingPositionSlider.disabled = false;
            btnFastForward.disabled = false;
            btnRewind.disabled = false;

            if (playbackManager.subtitleTracks(player).length) {
                view.querySelector('.btnSubtitles').classList.remove('hide');
            } else {
                view.querySelector('.btnSubtitles').classList.add('hide');
            }

            if (playbackManager.audioTracks(player).length > 1) {
                view.querySelector('.btnAudio').classList.remove('hide');
            } else {
                view.querySelector('.btnAudio').classList.add('hide');
            }
        }

        function setTitle(item, parentName) {

            var url = logoImageUrl(item, connectionManager.getApiClient(item.ServerId), {});

            if (url) {

                Emby.Page.setTitle('');

                var pageTitle = document.querySelector('.pageTitle');
                pageTitle.style.backgroundImage = "url('" + url + "')";
                pageTitle.classList.add('pageTitleWithLogo');
                pageTitle.classList.remove('pageTitleWithDefaultLogo');
                pageTitle.innerHTML = '';
            } else {
                Emby.Page.setTitle(parentName || '');
            }
        }

        function setPoster(item, secondaryItem) {

            var osdPoster = view.querySelector('.osdPoster');

            if (item) {

                var imgUrl = seriesImageUrl(item, { type: 'Primary' }) ||
                    seriesImageUrl(item, { type: 'Thumb' }) ||
                    imageUrl(item, { type: 'Primary' });

                if (!imgUrl && secondaryItem) {
                    imgUrl = seriesImageUrl(secondaryItem, { type: 'Primary' }) ||
                        seriesImageUrl(secondaryItem, { type: 'Thumb' }) ||
                        imageUrl(secondaryItem, { type: 'Primary' });
                }

                if (imgUrl) {
                    osdPoster.innerHTML = '<img src="' + imgUrl + '" />';
                    return;
                }
            }

            osdPoster.innerHTML = '';
        }

        function showOsd() {

            slideDownToShow(headerElement);
            showMainOsdControls();
            startOsdHideTimer();
        }

        function hideOsd() {

            slideUpToHide(headerElement);
            hideMainOsdControls();
        }

        function toggleOsd() {

            if (currentVisibleMenu === 'osd') {
                hideOsd();
            } else if (!currentVisibleMenu) {
                showOsd();
            }
        }

        var osdHideTimeout;
        function startOsdHideTimer() {
            stopOsdHideTimer();
            osdHideTimeout = setTimeout(hideOsd, 5000);
        }

        function stopOsdHideTimer() {
            if (osdHideTimeout) {
                clearTimeout(osdHideTimeout);
                osdHideTimeout = null;
            }
        }

        function slideDownToShow(elem) {

            elem.classList.remove('osdHeader-hidden');
        }

        function slideUpToHide(elem) {

            elem.classList.add('osdHeader-hidden');
        }

        function clearHideAnimationEventListeners(elem) {

            dom.removeEventListener(elem, transitionEndEventName, onHideAnimationComplete, {
                once: true
            });
        }

        function onHideAnimationComplete(e) {

            var elem = e.target;

            elem.classList.add('hide');

            dom.removeEventListener(elem, transitionEndEventName, onHideAnimationComplete, {
                once: true
            });
        }

        function showMainOsdControls() {

            if (currentVisibleMenu) {
                return;
            }

            var elem = osdBottomElement;

            currentVisibleMenu = 'osd';

            clearHideAnimationEventListeners(elem);

            elem.classList.remove('hide');

            // trigger a reflow to force it to animate again
            void elem.offsetWidth;

            elem.classList.remove('videoOsdBottom-hidden');

            setTimeout(function () {
                focusManager.focus(elem.querySelector('.btnPause'));
            }, 50);
        }

        function hideMainOsdControls() {

            if (currentVisibleMenu !== 'osd') {
                return;
            }

            var elem = osdBottomElement;

            clearHideAnimationEventListeners(elem);

            // trigger a reflow to force it to animate again
            void elem.offsetWidth;

            elem.classList.add('videoOsdBottom-hidden');

            dom.addEventListener(elem, transitionEndEventName, onHideAnimationComplete, {
                once: true
            });

            currentVisibleMenu = null;
        }

        var lastMouseMoveData;

        function onMouseMove(e) {

            var eventX = e.screenX || 0;
            var eventY = e.screenY || 0;

            var obj = lastMouseMoveData;
            if (!obj) {
                lastMouseMoveData = {
                    x: eventX,
                    y: eventY
                };
                return;
            }

            // if coord are same, it didn't move
            if (Math.abs(eventX - obj.x) < 10 && Math.abs(eventY - obj.y) < 10) {
                return;
            }

            obj.x = eventX;
            obj.y = eventY;

            showOsd();
        }

        function onInputCommand(e) {

            var player = currentPlayer;

            // support netflix commands: https://help.netflix.com/en/node/24855
            switch (e.detail.command) {

                case 'left':
                    if (currentVisibleMenu === 'osd') {
                        showOsd();
                    } else if (!currentVisibleMenu) {
                        e.preventDefault();
                        playbackManager.rewind(player);
                    }
                    break;
                case 'right':
                    if (currentVisibleMenu === 'osd') {
                        showOsd();
                    } else if (!currentVisibleMenu) {
                        e.preventDefault();
                        playbackManager.fastForward(player);
                    }
                    break;
                case 'pageup':
                    playbackManager.unpause(player);
                    break;
                case 'pagedown':
                    playbackManager.pause(player);
                    break;
                case 'up':
                case 'down':
                case 'select':
                case 'menu':
                case 'info':
                case 'play':
                case 'playpause':
                case 'pause':
                case 'fastforward':
                case 'rewind':
                case 'next':
                case 'previous':
                    showOsd();
                    break;
                case 'record':
                    onRecordingCommand();
                    showOsd();
                    break;
                case 'togglestats':
                    toggleStats();
                    break;
                default:
                    break;
            }
        }

        function onRecordingCommand() {
            var btnRecord = view.querySelector('.btnRecord');
            if (!btnRecord.classList.contains('hide')) {
                btnRecord.click();
            }
        }

        function updateFullscreenIcon() {
            if (playbackManager.isFullscreen(currentPlayer)) {
                view.querySelector('.btnFullscreen').setAttribute('title', globalize.translate('ExitFullscreen'));
                view.querySelector('.btnFullscreen i').innerHTML = '&#xE5D1;';
            } else {
                view.querySelector('.btnFullscreen').setAttribute('title', globalize.translate('Fullscreen'));
                view.querySelector('.btnFullscreen i').innerHTML = '&#xE5D0;';
            }
        }

        view.addEventListener('viewbeforeshow', function (e) {

            headerElement.classList.add('osdHeader');
            // Make sure the UI is completely transparent
            Emby.Page.setTransparency('full');
        });

        view.addEventListener('viewshow', function (e) {

            events.on(playbackManager, 'playerchange', onPlayerChange);
            bindToPlayer(playbackManager.getCurrentPlayer());

            dom.addEventListener(document, 'mousemove', onMouseMove, {
                passive: true
            });
            document.body.classList.add('autoScrollY');

            showOsd();

            inputManager.on(window, onInputCommand);

            dom.addEventListener(window, 'keydown', onWindowKeyDown, {
                passive: true
            });
        });

        view.addEventListener('viewbeforehide', function () {

            if (statsOverlay) {
                statsOverlay.enabled(false);
            }

            dom.removeEventListener(window, 'keydown', onWindowKeyDown, {
                passive: true
            });

            stopOsdHideTimer();
            headerElement.classList.remove('osdHeader');
            headerElement.classList.remove('osdHeader-hidden');
            dom.removeEventListener(document, 'mousemove', onMouseMove, {
                passive: true
            });
            document.body.classList.remove('autoScrollY');

            inputManager.off(window, onInputCommand);
            events.off(playbackManager, 'playerchange', onPlayerChange);
            releaseCurrentPlayer();
        });

        if (appHost.supports('remotecontrol') && !layoutManager.tv) {
            view.querySelector('.btnCast').classList.remove('hide');
        }

        view.querySelector('.btnCast').addEventListener('click', function () {
            var btn = this;
            require(['playerSelectionMenu'], function (playerSelectionMenu) {
                playerSelectionMenu.show(btn);
            });
        });

        view.querySelector('.btnFullscreen').addEventListener('click', function () {
            playbackManager.toggleFullscreen(currentPlayer);
        });

        view.querySelector('.btnPip').addEventListener('click', function () {
            playbackManager.togglePictureInPicture(currentPlayer);
        });

        view.querySelector('.btnVideoOsdSettings').addEventListener('click', onSettingsButtonClick);

        function onPlayerChange() {

            var player = playbackManager.getCurrentPlayer();

            if (player && !player.isLocalPlayer) {
                view.querySelector('.btnCast i').innerHTML = '&#xE308;';
            } else {
                view.querySelector('.btnCast i').innerHTML = '&#xE307;';
            }
            bindToPlayer(player);
        }

        function onStateChanged(event, state) {

            //console.log('nowplaying event: ' + e.type);
            var player = this;

            if (!state.NowPlayingItem) {
                return;
            }

            isEnabled = true;

            updatePlayerStateInternal(event, player, state);
            updatePlaylist(player);

            enableStopOnBack(true);
        }

        function onPlayPauseStateChanged(e) {

            if (!isEnabled) {
                return;
            }

            var player = this;
            updatePlayPauseState(player.paused());
        }

        function onVolumeChanged(e) {

            if (!isEnabled) {
                return;
            }

            var player = this;

            updatePlayerVolumeState(player, player.isMuted(), player.getVolume());
        }

        function onPlaybackStart(e, state) {

            console.log('nowplaying event: ' + e.type);

            var player = this;

            onStateChanged.call(player, e, state);
            resetUpNextDialog();
        }

        function resetUpNextDialog() {

            comingUpNextDisplayed = false;
            var dlg = currentUpNextDialog;

            if (dlg) {
                dlg.destroy();
                currentUpNextDialog = null;
            }
        }

        function onPlaybackStopped(e, state) {

            currentRuntimeTicks = null;
            resetUpNextDialog();

            console.log('nowplaying event: ' + e.type);

            if (state.NextMediaType !== 'Video') {

                view.removeEventListener('viewbeforehide', onViewHideStopPlayback);

                Emby.Page.back();
            }
        }

        function bindToPlayer(player) {

            if (player === currentPlayer) {
                return;
            }

            releaseCurrentPlayer();

            currentPlayer = player;

            if (!player) {
                return;
            }

            var state = playbackManager.getPlayerState(player);
            onStateChanged.call(player, { type: 'init' }, state);

            events.on(player, 'playbackstart', onPlaybackStart);
            events.on(player, 'playbackstop', onPlaybackStopped);
            events.on(player, 'volumechange', onVolumeChanged);
            events.on(player, 'pause', onPlayPauseStateChanged);
            events.on(player, 'unpause', onPlayPauseStateChanged);
            events.on(player, 'timeupdate', onTimeUpdate);
            events.on(player, 'fullscreenchange', updateFullscreenIcon);

            resetUpNextDialog();
        }

        function releaseCurrentPlayer() {

            destroyStats();
            resetUpNextDialog();

            var player = currentPlayer;

            if (player) {

                events.off(player, 'playbackstart', onPlaybackStart);
                events.off(player, 'playbackstop', onPlaybackStopped);
                events.off(player, 'volumechange', onVolumeChanged);
                events.off(player, 'pause', onPlayPauseStateChanged);
                events.off(player, 'unpause', onPlayPauseStateChanged);
                events.off(player, 'timeupdate', onTimeUpdate);
                events.off(player, 'fullscreenchange', updateFullscreenIcon);

                currentPlayer = null;
            }
        }

        function onTimeUpdate(e) {

            if (!isEnabled) {
                return;
            }

            // Try to avoid hammering the document with changes
            var now = new Date().getTime();
            if ((now - lastUpdateTime) < 700) {

                return;
            }
            lastUpdateTime = now;

            var player = this;
            currentRuntimeTicks = playbackManager.duration(player);

            var currentTime = playbackManager.currentTime(player);
            updateTimeDisplay(currentTime, currentRuntimeTicks, playbackManager.playbackStartTime(player), playbackManager.getBufferedRanges(player));

            refreshProgramInfoIfNeeded(player);
            showComingUpNextIfNeeded(player, currentItem, currentTime, currentRuntimeTicks);
        }

        function showComingUpNextIfNeeded(player, currentItem, currentTimeTicks, runtimeTicks) {

            if (runtimeTicks && currentTimeTicks && !comingUpNextDisplayed && !currentVisibleMenu && currentItem.Type === 'Episode' && userSettings.enableNextVideoInfoOverlay()) {

                var minRuntimeTicks = 600 * 1000 * 10000;

                var fiftyMinuteTicks = 3000 * 1000 * 10000;
                var fortyMinuteTicks = 2400 * 1000 * 10000;

                var showAtSecondsLeft = runtimeTicks >= fiftyMinuteTicks ? 40 : (runtimeTicks >= fortyMinuteTicks ? 35 : 30);
                var showAtTicks = runtimeTicks - (showAtSecondsLeft * 1000 * 10000);

                var timeRemainingTicks = runtimeTicks - currentTimeTicks;
                var minTimeRemainingTicks = (20 * 1000 * 10000);

                if (currentTimeTicks >= showAtTicks && runtimeTicks >= minRuntimeTicks && timeRemainingTicks >= minTimeRemainingTicks) {
                    showComingUpNext(player);
                }
            }
        }

        function onUpNextHidden() {

            if (currentVisibleMenu === 'upnext') {
                currentVisibleMenu = null;
            }
        }

        function showComingUpNext(player) {

            require(['upNextDialog'], function (UpNextDialog) {

                if (currentVisibleMenu || currentUpNextDialog) {
                    return;
                }

                currentVisibleMenu = 'upnext';
                comingUpNextDisplayed = true;

                currentUpNextDialog = new UpNextDialog({
                    parent: view.querySelector('.upNextContainer'),
                    player: player
                });

                events.on(currentUpNextDialog, 'hide', onUpNextHidden);
            });
        }

        function refreshProgramInfoIfNeeded(player) {
            var item = currentItem;
            if (item.Type !== 'TvChannel') {
                return;
            }

            var program = item.CurrentProgram;
            if (!program || !program.EndDate) {
                return;
            }

            try {

                var endDate = datetime.parseISO8601Date(program.EndDate);

                // program has changed and needs to be refreshed
                if (new Date().getTime() >= endDate.getTime()) {

                    console.log('program info needs to be refreshed');

                    var state = playbackManager.getPlayerState(player);
                    onStateChanged.call(player, { type: 'init' }, state);
                }
            }
            catch (e) {
                console.log("Error parsing date: " + program.EndDate);
            }
        }

        function updatePlayPauseState(isPaused) {

            if (isPaused) {
                view.querySelector('.btnPause i').innerHTML = '&#xE037;';
            } else {
                view.querySelector('.btnPause i').innerHTML = '&#xE034;';
            }
        }

        function updatePlayerStateInternal(event, player, state) {

            var playState = state.PlayState || {};

            updatePlayPauseState(playState.IsPaused);

            var supportedCommands = playbackManager.getSupportedCommands(player);
            currentPlayerSupportedCommands = supportedCommands;

            supportsBrightnessChange = supportedCommands.indexOf('SetBrightness') !== -1;

            //if (supportedCommands.indexOf('SetRepeatMode') == -1) {
            //    toggleRepeatButton.classList.add('hide');
            //} else {
            //    toggleRepeatButton.classList.remove('hide');
            //}

            //if (playState.RepeatMode == 'RepeatAll') {
            //    toggleRepeatButtonIcon.innerHTML = "repeat";
            //    toggleRepeatButton.classList.add('repeatActive');
            //}
            //else if (playState.RepeatMode == 'RepeatOne') {
            //    toggleRepeatButtonIcon.innerHTML = "repeat_one";
            //    toggleRepeatButton.classList.add('repeatActive');
            //} else {
            //    toggleRepeatButtonIcon.innerHTML = "repeat";
            //    toggleRepeatButton.classList.remove('repeatActive');
            //}

            updatePlayerVolumeState(player, playState.IsMuted, playState.VolumeLevel);

            if (nowPlayingPositionSlider && !nowPlayingPositionSlider.dragging) {
                nowPlayingPositionSlider.disabled = !playState.CanSeek;
            }

            btnFastForward.disabled = !playState.CanSeek;
            btnRewind.disabled = !playState.CanSeek;

            var nowPlayingItem = state.NowPlayingItem || {};

            playbackStartTimeTicks = playState.PlaybackStartTimeTicks;
            updateTimeDisplay(playState.PositionTicks, nowPlayingItem.RunTimeTicks, playState.PlaybackStartTimeTicks, playState.BufferedRanges || []);

            updateNowPlayingInfo(player, state);

            if (state.MediaSource && state.MediaSource.SupportsTranscoding && supportedCommands.indexOf('SetMaxStreamingBitrate') !== -1) {
                view.querySelector('.btnVideoOsdSettings').classList.remove('hide');
            } else {
                view.querySelector('.btnVideoOsdSettings').classList.add('hide');
            }

            if (supportedCommands.indexOf('ToggleFullscreen') === -1 || (player.isLocalPlayer && layoutManager.tv && playbackManager.isFullscreen(player))) {
                view.querySelector('.btnFullscreen').classList.add('hide');
            } else {
                view.querySelector('.btnFullscreen').classList.remove('hide');
            }

            if (supportedCommands.indexOf('PictureInPicture') === -1) {
                view.querySelector('.btnPip').classList.add('hide');
            } else {
                view.querySelector('.btnPip').classList.remove('hide');
            }

            updateFullscreenIcon();
        }

        function getDisplayPercentByTimeOfDay(programStartDateMs, programRuntimeMs, currentTimeMs) {

            return ((currentTimeMs - programStartDateMs) / programRuntimeMs) * 100;
        }

        function updateTimeDisplay(positionTicks, runtimeTicks, playbackStartTimeTicks, bufferedRanges) {

            if (enableProgressByTimeOfDay) {

                if (nowPlayingPositionSlider && !nowPlayingPositionSlider.dragging) {

                    if (programStartDateMs && programEndDateMs) {

                        var currentTimeMs = (playbackStartTimeTicks + (positionTicks || 0)) / 10000;
                        var programRuntimeMs = programEndDateMs - programStartDateMs;

                        nowPlayingPositionSlider.value = getDisplayPercentByTimeOfDay(programStartDateMs, programRuntimeMs, currentTimeMs);

                        if (bufferedRanges.length) {

                            var rangeStart = getDisplayPercentByTimeOfDay(programStartDateMs, programRuntimeMs, (playbackStartTimeTicks + (bufferedRanges[0].start || 0)) / 10000);
                            var rangeEnd = getDisplayPercentByTimeOfDay(programStartDateMs, programRuntimeMs, (playbackStartTimeTicks + (bufferedRanges[0].end || 0)) / 10000);

                            nowPlayingPositionSlider.setBufferedRanges([
                                {
                                    start: rangeStart,
                                    end: rangeEnd
                                }]);

                        } else {
                            nowPlayingPositionSlider.setBufferedRanges([]);
                        }

                    } else {
                        nowPlayingPositionSlider.value = 0;
                        nowPlayingPositionSlider.setBufferedRanges([]);
                    }
                }

                nowPlayingPositionText.innerHTML = '';
                nowPlayingDurationText.innerHTML = '';


            } else {
                if (nowPlayingPositionSlider && !nowPlayingPositionSlider.dragging) {
                    if (runtimeTicks) {

                        var pct = positionTicks / runtimeTicks;
                        pct *= 100;

                        nowPlayingPositionSlider.value = pct;

                    } else {

                        nowPlayingPositionSlider.value = 0;
                    }

                    // Check currentItem.RunTimeTicks as well to avoid showing endsAt for live streams
                    // Also check for recordings because they'll have a runtime which equals the amount recorded
                    if (runtimeTicks && positionTicks != null && currentRuntimeTicks && !enableProgressByTimeOfDay && currentItem.RunTimeTicks && currentItem.Type !== 'Recording') {
                        endsAtText.innerHTML = '&nbsp;&nbsp;-&nbsp;&nbsp;' + mediaInfo.getEndsAtFromPosition(runtimeTicks, positionTicks, true);
                    } else {
                        endsAtText.innerHTML = '';
                    }
                }

                if (nowPlayingPositionSlider) {
                    nowPlayingPositionSlider.setBufferedRanges(bufferedRanges, runtimeTicks, positionTicks);
                }

                updateTimeText(nowPlayingPositionText, positionTicks);
                updateTimeText(nowPlayingDurationText, runtimeTicks, true);
            }
        }

        function updatePlayerVolumeState(player, isMuted, volumeLevel) {

            var supportedCommands = currentPlayerSupportedCommands;

            var showMuteButton = true;
            var showVolumeSlider = true;

            if (supportedCommands.indexOf('Mute') === -1) {
                showMuteButton = false;
            }

            if (supportedCommands.indexOf('SetVolume') === -1) {
                showVolumeSlider = false;
            }

            if (player.isLocalPlayer && appHost.supports('physicalvolumecontrol')) {
                showMuteButton = false;
                showVolumeSlider = false;
            }

            if (isMuted) {
                view.querySelector('.buttonMute').setAttribute('title', globalize.translate('Unmute'));
                view.querySelector('.buttonMute i').innerHTML = '&#xE04F;';
            } else {
                view.querySelector('.buttonMute').setAttribute('title', globalize.translate('Mute'));
                view.querySelector('.buttonMute i').innerHTML = '&#xE050;';
            }

            if (showMuteButton) {
                view.querySelector('.buttonMute').classList.remove('hide');
            } else {
                view.querySelector('.buttonMute').classList.add('hide');
            }

            // See bindEvents for why this is necessary
            if (nowPlayingVolumeSlider) {

                if (showVolumeSlider) {
                    nowPlayingVolumeSliderContainer.classList.remove('hide');
                } else {
                    nowPlayingVolumeSliderContainer.classList.add('hide');
                }

                if (!nowPlayingVolumeSlider.dragging) {
                    nowPlayingVolumeSlider.value = volumeLevel || 0;
                }
            }
        }

        function updatePlaylist(player) {

            var btnPreviousTrack = view.querySelector('.btnPreviousTrack');
            var btnNextTrack = view.querySelector('.btnNextTrack');

            btnPreviousTrack.classList.remove('hide');
            btnNextTrack.classList.remove('hide');

            btnNextTrack.disabled = false;
            btnPreviousTrack.disabled = false;
        }

        function updateTimeText(elem, ticks, divider) {

            if (ticks == null) {
                elem.innerHTML = '';
                return;
            }

            var html = datetime.getDisplayRunningTime(ticks);

            if (divider) {
                html = '&nbsp;/&nbsp;' + html;
            }

            elem.innerHTML = html;
        }

        function onSettingsButtonClick(e) {

            var btn = this;

            require(['playerSettingsMenu'], function (playerSettingsMenu) {

                var player = currentPlayer;

                if (!player) {
                    return;
                }

                playerSettingsMenu.show({
                    mediaType: 'Video',
                    player: player,
                    positionTo: btn,
                    stats: true,
                    onOption: onSettingsOption

                });
            });
        }

        function onSettingsOption(selectedOption) {

            if (selectedOption === 'stats') {
                toggleStats();
            }
        }

        function toggleStats() {

            require(['playerStats'], function (PlayerStats) {

                var player = currentPlayer;

                if (!player) {
                    return;
                }

                if (statsOverlay) {
                    statsOverlay.toggle();
                } else {
                    statsOverlay = new PlayerStats({
                        player: player
                    });
                }
            });
        }

        function destroyStats() {

            if (statsOverlay) {
                statsOverlay.destroy();
                statsOverlay = null;
            }
        }

        function showAudioTrackSelection() {

            var player = currentPlayer;

            var audioTracks = playbackManager.audioTracks(player);

            var currentIndex = playbackManager.getAudioStreamIndex(player);

            var menuItems = audioTracks.map(function (stream) {

                var opt = {
                    name: stream.DisplayTitle,
                    id: stream.Index
                };

                if (stream.Index === currentIndex) {
                    opt.selected = true;
                }

                return opt;
            });

            var positionTo = this;

            require(['actionsheet'], function (actionsheet) {

                actionsheet.show({
                    items: menuItems,
                    title: globalize.translate('Audio'),
                    positionTo: positionTo
                }).then(function (id) {
                    var index = parseInt(id);
                    if (index !== currentIndex) {
                        playbackManager.setAudioStreamIndex(index, player);
                    }
                });
            });
        }

        function showSubtitleTrackSelection() {

            var player = currentPlayer;

            var streams = playbackManager.subtitleTracks(player);

            var currentIndex = playbackManager.getSubtitleStreamIndex(player);
            if (currentIndex == null) {
                currentIndex = -1;
            }

            streams.unshift({
                Index: -1,
                DisplayTitle: globalize.translate('Off')
            });

            var menuItems = streams.map(function (stream) {

                var opt = {
                    name: stream.DisplayTitle,
                    id: stream.Index
                };

                if (stream.Index === currentIndex) {
                    opt.selected = true;
                }

                return opt;
            });

            var positionTo = this;

            require(['actionsheet'], function (actionsheet) {

                actionsheet.show({
                    title: globalize.translate('Subtitles'),
                    items: menuItems,
                    positionTo: positionTo
                }).then(function (id) {
                    var index = parseInt(id);
                    if (index !== currentIndex) {
                        playbackManager.setSubtitleStreamIndex(index, player);
                    }
                });

            });
        }

        view.addEventListener('viewhide', function () {

            headerElement.classList.remove('hide');
        });

        view.addEventListener('viewdestroy', function () {

            if (self.touchHelper) {
                self.touchHelper.destroy();
                self.touchHelper = null;
            }
            if (recordingButtonManager) {
                recordingButtonManager.destroy();
                recordingButtonManager = null;
            }
            destroyStats();
        });

        function onWindowKeyDown(e) {

            if (!currentVisibleMenu) {
                if (e.keyCode === 32 || e.keyCode === 13) {
                    playbackManager.playPause(currentPlayer);
                    showOsd();
                    return;
                }
            }

            switch (e.key) {

                case 'f':
                    if (!e.ctrlKey) {
                        playbackManager.toggleFullscreen(currentPlayer);
                    }
                    break;
                case 'm':
                    playbackManager.toggleMute(currentPlayer);
                    break;
                case 'ArrowLeft':
                case 'Left':
                case 'NavigationLeft':
                case 'GamepadDPadLeft':
                case 'GamepadLeftThumbstickLeft':
                    {
                        if (!!e.shiftKey) {
                            // shift-left
                            playbackManager.rewind(currentPlayer);
                        }
                        break;
                    }
                case 'ArrowRight':
                case 'Right':
                case 'NavigationRight':
                case 'GamepadDPadRight':
                case 'GamepadLeftThumbstickRight':
                    {
                        if (!!e.shiftKey) {
                            // shift-left
                            playbackManager.fastForward(currentPlayer);
                        }
                        break;
                    }
                default:
                    break;
            }
        }

        view.addEventListener((window.PointerEvent ? 'pointerdown' : 'click'), function (e) {

            var isClickInControlsArea = dom.parentWithClass(e.target, ['videoOsdBottom', 'upNextContainer']);

            if (isClickInControlsArea) {
                showOsd();

                return;
            }

            var pointerType = e.pointerType || (layoutManager.mobile ? 'touch' : 'mouse');

            switch (pointerType) {

                case 'touch':
                    toggleOsd();
                    break;
                default:
                    playbackManager.playPause(currentPlayer);
                    showOsd();
                    break;
            }
        });

        if (browser.touch) {
            view.addEventListener('dblclick', onDoubleClick);
        }

        view.querySelector('.buttonMute').addEventListener('click', function () {

            playbackManager.toggleMute(currentPlayer);
        });

        nowPlayingVolumeSlider.addEventListener('change', function () {

            playbackManager.setVolume(this.value, currentPlayer);
        });

        nowPlayingPositionSlider.addEventListener('change', function () {

            var player = currentPlayer;
            if (player) {

                var newPercent = parseFloat(this.value);

                if (enableProgressByTimeOfDay) {

                    var seekAirTimeTicks = (programEndDateMs - programStartDateMs) * (newPercent / 100) * 10000;
                    seekAirTimeTicks += (programStartDateMs * 10000);
                    seekAirTimeTicks -= playbackStartTimeTicks;

                    playbackManager.seek(seekAirTimeTicks, player);
                }
                else {
                    playbackManager.seekPercent(newPercent, player);
                }
            }
        });

        function getImgUrl(item, chapter, index, maxWidth, apiClient) {

            if (chapter.ImageTag) {

                return apiClient.getScaledImageUrl(item.Id, {
                    maxWidth: maxWidth,
                    tag: chapter.ImageTag,
                    type: "Chapter",
                    index: index
                });
            }

            return null;
        }

        function getChapterBubbleHtml(apiClient, item, chapters, positionTicks) {

            var chapter;
            var index = -1;

            for (var i = 0, length = chapters.length; i < length; i++) {

                var currentChapter = chapters[i];

                if (positionTicks >= currentChapter.StartPositionTicks) {
                    chapter = currentChapter;
                    index = i;
                }
            }

            if (!chapter) {
                return null;
            }

            var src = getImgUrl(item, chapter, index, 400, apiClient);

            if (src) {

                var html = '<div class="chapterThumbContainer">';
                html += '<img class="chapterThumb" src="' + src + '" />';

                html += '<div class="chapterThumbTextContainer">';
                html += '<div class="chapterThumbText chapterThumbText-dim">';
                html += chapter.Name;
                html += '</div>';
                html += '<h1 class="chapterThumbText">';
                html += datetime.getDisplayRunningTime(positionTicks);
                html += '</h1>';
                html += '</div>';

                html += '</div>';

                return html;
            }

            return null;
        }

        nowPlayingPositionSlider.getBubbleHtml = function (value) {

            showOsd();

            if (enableProgressByTimeOfDay) {

                if (programStartDateMs && programEndDateMs) {

                    var ms = programEndDateMs - programStartDateMs;
                    ms /= 100;
                    ms *= value;

                    ms += programStartDateMs;

                    var date = new Date(parseInt(ms));

                    return '<h1 class="sliderBubbleText">' + getDisplayTimeWithoutAmPm(date, true) + '</h1>';

                } else {
                    return '--:--';
                }

            } else {
                if (!currentRuntimeTicks) {
                    return '--:--';
                }

                var ticks = currentRuntimeTicks;
                ticks /= 100;
                ticks *= value;

                var item = currentItem;
                if (item && item.Chapters && item.Chapters.length && item.Chapters[0].ImageTag) {
                    var html = getChapterBubbleHtml(connectionManager.getApiClient(item.ServerId), item, item.Chapters, ticks);

                    if (html) {
                        return html;
                    }
                }

                return '<h1 class="sliderBubbleText">' + datetime.getDisplayRunningTime(ticks) + '</h1>';
            }
        };

        view.querySelector('.btnPreviousTrack').addEventListener('click', function () {

            playbackManager.previousTrack(currentPlayer);
        });

        view.querySelector('.btnPause').addEventListener('click', function () {

            playbackManager.playPause(currentPlayer);
        });

        view.querySelector('.btnNextTrack').addEventListener('click', function () {

            playbackManager.nextTrack(currentPlayer);
        });

        btnRewind.addEventListener('click', function () {

            playbackManager.rewind(currentPlayer);
        });

        btnFastForward.addEventListener('click', function () {

            playbackManager.fastForward(currentPlayer);
        });

        view.querySelector('.btnAudio').addEventListener('click', showAudioTrackSelection);
        view.querySelector('.btnSubtitles').addEventListener('click', showSubtitleTrackSelection);

        if (browser.touch) {
            initSwipeEvents();
        }

        function onViewHideStopPlayback() {

            if (playbackManager.isPlayingVideo()) {

                var player = currentPlayer;

                // Unbind this event so that we don't go back twice
                view.removeEventListener('viewbeforehide', onViewHideStopPlayback);

                releaseCurrentPlayer();

                playbackManager.stop(player);

                // or 
                //Emby.Page.setTransparency(Emby.TransparencyLevel.Backdrop);
            }
        }

        function enableStopOnBack(enabled) {

            view.removeEventListener('viewbeforehide', onViewHideStopPlayback);

            if (enabled) {
                if (playbackManager.isPlayingVideo(currentPlayer)) {
                    view.addEventListener('viewbeforehide', onViewHideStopPlayback);
                }
            }
        }

    };

});