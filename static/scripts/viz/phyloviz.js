define(['libs/d3', 'viz/visualization', 'mvc/data'], function(d3, visualization_mod, data_mod) {

var UserMenuBase = Backbone.View.extend({
    /**
     * Base class of any menus that takes in user interaction. Contains checking methods.
     */

    className: 'UserMenuBase',

    isAcceptableValue : function ($inputKey, min, max) {
        /**
         * Check if an input value is a number and falls within max min.
         */
        var self = this,
            value = $inputKey.val(),
            fieldName = $inputKey.attr("displayLabel") || $inputKey.attr("id").replace("phyloViz", "");

        function isNumeric(n) {
            return !isNaN(parseFloat(n)) && isFinite(n);
        }

        if (!isNumeric(value)){
            alert(fieldName + " is not a number!");
            return false;
        }

        if ( value > max){
            alert(fieldName + " is too large.");
            return false;
        } else if ( value < min) {
            alert(fieldName + " is too small.");
            return false;
        }
        return true;
    },

    hasIllegalJsonCharacters : function($inputKey) {
        /**
         * Check if any user string inputs has illegal characters that json cannot accept
         */
        if ($inputKey.val().search(/"|'|\\/) !== -1){
            alert("Named fields cannot contain these illegal characters: double quote(\"), single guote(\'), or back slash(\\). ");
            return true;
        }
        return false;
    }
});


function PhyloTreeLayout() {
    /**
     * -- Custom Layout call for phyloViz to suit the needs of a phylogenetic tree.
     * -- Specifically: 1) Nodes have a display display of (= evo dist X depth separation) from their parent
     *                  2) Nodes must appear in other after they have expand and contracted
     */

    var self = this,
        hierarchy = d3.layout.hierarchy().sort(null).value(null),
        height = 360, // ! represents both the layout angle and the height of the layout, in px
        layoutMode = "Linear",
        leafHeight = 18, // height of each individual leaf node
        depthSeparation = 200, // separation between nodes of different depth, in px
        leafIndex = 0, // change to recurssive call
        defaultDist = 0.5, // tree defaults to 0.5 dist if no dist is specified
        maxTextWidth = 50; // maximum length of the text labels


    self.leafHeight = function(inputLeafHeight){
        if (typeof inputLeafHeight === "undefined"){ return leafHeight; }
        else { leafHeight = inputLeafHeight; return self;}
    };

    self.layoutMode = function(mode){
        if (typeof mode === "undefined"){ return layoutMode; }
        else { layoutMode = mode; return self;}
    };

    self.layoutAngle = function(angle) {    // changes the layout angle of the display, which is really changing the height
        if (typeof angle === "undefined"){ return height; }
        if (isNaN(angle) || angle < 0 || angle > 360) { return self; } // to use default if the user puts in strange values
        else { height = angle; return self;}
    };

    self.separation = function(dist){   // changes the dist between the nodes of different depth
        if (typeof dist === "undefined"){ return depthSeparation; }
        else { depthSeparation = dist; return self;}
    };

    self.links = function (nodes) {     // uses d3 native method to generate links. Done.
        return d3.layout.tree().links(nodes);
    };

    // -- Custom method for laying out phylogeny tree in a linear fashion
    self.nodes = function (d, i) {
        var _nodes = hierarchy.call(self, d, i),         // self is to find the depth of all the nodes, assumes root is passed in
            nodes = [],
            maxDepth = 0,
            numLeaves = 0;

        // changing from hierarchy's custom format for data to usable format
        _nodes.forEach(function (_node){
            var node = _node.data;
            node.depth = _node.depth;
            maxDepth = node.depth > maxDepth ? node.depth : maxDepth;  //finding max depth of tree
            nodes.push(node);
        });
        // counting the number of leaf nodes and assigning max depth to nodes that do not have children to flush all the leave nodes
        nodes.forEach(function(node){
            if ( !node.children )  { //&& !node._children
                numLeaves += 1;
                node.depth = maxDepth; // if a leaf has no child it would be assigned max depth
            }
        });

        leafHeight = layoutMode === "Circular" ? height / numLeaves : leafHeight;
        leafIndex = 0;
        layout(nodes[0], maxDepth, leafHeight, null);

        return nodes;
    };


    function layout (node, maxDepth, vertSeparation, parent) {
        /**
         * -- Function with side effect of adding x0, y0 to all child; take in the root as starting point
         *  assuming that the leave nodes would be sorted in presented order
         *          horizontal(y0) is calculated according to (= evo dist X depth separation) from their parent
         *          vertical (x0) - if leave node: find its order in all of the  leave node === node.id, then multiply by verticalSeparation
         *                  - if parent node: is place in the mid point all of its children nodes
         * -- The layout will first calculate the y0 field going towards the leaves, and x0 when returning
         */
        var children = node.children,
            sumChildVertSeparation = 0;

        // calculation of node's dist from parents, going down.
        var dist = node.dist || defaultDist;
        dist = dist > 1 ? 1 : dist;     // We constrain all dist to be less than one
        node.dist = dist;
        if (parent !== null){
            node.y0 = parent.y0 + dist * depthSeparation;
        } else {    //root node
            node.y0 = maxTextWidth;
        }


        // if a node have no children, we will treat it as a leaf and start laying it out first
        if (!children) {
            node.x0 = leafIndex++ * vertSeparation;
        } else {
            // if it has children, we will visit all its children and calculate its position from its children
            children.forEach( function (child) {
                child.parent = node;
                sumChildVertSeparation += layout(child, maxDepth, vertSeparation, node);
            });
            node.x0 = sumChildVertSeparation / children.length;
        }

        // adding properties to the newly created node
        node.x = node.x0;
        node.y = node.y0;
        return node.x0;
    }
    return self;
}


/**
 * -- PhyloTree Model --
 */
var PhyloTree = visualization_mod.Visualization.extend({
    defaults : {
        layout: "Linear",
        separation : 250,    // px dist between nodes of different depth to represent 1 evolutionary until
        leafHeight: 18,
        type : "phyloviz",   // visualization type
        title : "Title",
        scaleFactor: 1,
        translate: [0,0],
        fontSize: 12,        //fontSize of node label
        selectedNode : null,
        nodeAttrChangedTime : 0
    },

    initialize: function(options) {
        this.set("dataset", new data_mod.Dataset({
            id: options.dataset_id
        }));
    },

    root : {}, // Root has to be its own independent object because it is not part of the viz_config

    toggle : function (d) {
        /**
         * Mechanism to expand or contract a single node. Expanded nodes have a children list, while for
         * contracted nodes the list is stored in _children. Nodes with their children data stored in _children will not have their
         * children rendered.
         */
        if(typeof d === "undefined") {return ;}
        if (d.children ) {
            d._children = d.children;
            d.children = null;
        } else {
            d.children = d._children;
            d._children = null;
        }
    },

    toggleAll : function(d) {
        /**
         *  Contracts the phylotree to a single node by repeatedly calling itself to place all the list
         *  of children under _children.
         */
        if (d.children && d.children.length !== 0) {
            d.children.forEach(this.toggleAll);
            toggle(d);
        }
    },

    getData : function (){
        /**
         *  Return the data of the tree. Used for preserving state.
         */
        return this.root;
    },

    save: function() {
        /**
         * Overriding the default save mechanism to do some clean of circular reference of the
         * phyloTree and to include phyloTree in the saved json
         */
        var root = this.root;
        cleanTree(root);
        this.set("root", root);

        function cleanTree(node){
            // we need to remove parent to delete circular reference
            delete node.parent;

            // removing unnecessary attributes
            if (node._selected){ delete node._selected;}

            if (node.children) {
                node.children.forEach(cleanTree);                
            }
            if (node._children) {
                node._children.forEach(cleanTree);
            }
        }

        var config  = jQuery.extend(true, {}, this.attributes);
        config.selectedNode = null;

        show_message("Saving to Galaxy", "progress");

        return $.ajax({
            url: this.url(),
            type: "POST",
            dataType: "json",
            data: {
                vis_json: JSON.stringify(config)
            },
            success: function(res){
                var viz_id = res.url.split("id=")[1].split("&")[0],
                    viz_url = "/visualization?id=" + viz_id;
                window.history.pushState({}, "", viz_url + window.location.hash);
                hide_modal();
            }
        });
    }
});



/**
 * -- Views --
 */
var PhylovizLayoutBase =  Backbone.View.extend({
    /**
     *  Stores the default variable for setting up the visualization
     */
    defaults : {
        nodeRadius : 4.5 // radius of each node in the diagram
    },


    stdInit : function (options) {
        /**
         *  Common initialization in layouts
         */

        var self = this;
        self.model.on("change:separation change:leafHeight change:fontSize change:nodeAttrChangedTime", self.updateAndRender, self);

        self.vis = options.vis;
        self.i = 0;
        self.maxDepth = -1; // stores the max depth of the tree

        self.width = options.width;
        self.height = options.height;
    },


    updateAndRender : function(source) {
        /**
         *  Updates the visualization whenever there are changes in the expansion and contraction of nodes
         *  AND possibly when the tree is edited.
         */
        var vis = d3.select(".vis"),
            self = this;
        source = source || self.model.root;

        self.renderNodes(source);
        self.renderLinks(source);
        self.addTooltips();
    },


    renderLinks : function(source) {
        /**
         * Renders the links for the visualization.
         */
        var self = this;
        var diagonal = self.diagonal;
        var duration = self.duration;
        var layoutMode = self.layoutMode;
        var link = self.vis.selectAll("g.completeLink")
            .data(self.tree.links(self.nodes), function(d) { return d.target.id; });

        var calcalateLinePos = function(d) {
            d.pos0 = d.source.y0 + " " + d.source.x0;   // position of the source node <=> starting location of the line drawn
            d.pos1 = d.source.y0 + " " + d.target.x0;  // position where the line makes a right angle bend
            d.pos2 = d.target.y0 + " " + d.target.x0;     // point where the horizontal line becomes a dotted line
        };

        var linkEnter = link.enter().insert("svg:g","g.node")
            .attr("class", "completeLink");


        linkEnter.append("svg:path")
            .attr("class", "link")
            .attr("d", function(d) {
                calcalateLinePos(d);
                return "M " + d.pos0  + " L " + d.pos1;
            });

        var linkUpdate = link.transition().duration(500);

        linkUpdate.select("path.link")
            .attr("d", function(d) {
                calcalateLinePos(d);
                return "M " + d.pos0 + " L " + d.pos1 + " L " + d.pos2;
            });

        var linkExit = link.exit().remove();

    },

    // User Interaction methods below

    selectNode : function(node){
        /**
         *  Displays the information for editting
         */
        var self = this;
        d3.selectAll("g.node")
            .classed("selectedHighlight", function(d){
                if (node.id === d.id){
                    if(node._selected) { // for de=selecting node.
                        delete node._selected;
                        return false;
                    } else {
                        node._selected = true;
                        return true;
                    }
                }
                return false;
            });

        self.model.set("selectedNode", node);
        $("#phyloVizSelectedNodeName").val(node.name);
        $("#phyloVizSelectedNodeDist").val(node.dist);
        $("#phyloVizSelectedNodeAnnotation").val(node.annotation || "");
    },

    addTooltips : function (){
        /**
         *  Creates bootstrap tooltip for the visualization. Has to be called repeatedly due to newly generated
         *  enterNodes
         */
        $(".bs-tooltip").remove();      //clean up tooltip, just in case its listeners are removed by d3
        $(".node")
            .attr("data-original-title", function(){
                var d = this.__data__,
                    annotation = d.annotation || "None" ;
                return d ? (d.name ? d.name + "<br/>" : "") + "Dist: " + d.dist + " <br/>Annotation: " + annotation: "";
            })
            .tooltip({'placement':'top', 'trigger' : 'hover'});

    }
});




var PhylovizLinearView =  PhylovizLayoutBase.extend({
    /**
     * Linea layout class of Phyloviz, is responsible for rendering the nodes
     * calls PhyloTreeLayout to determine the positions of the nodes
     */
    initialize : function(options){
        // Default values of linear layout
        var self = this;
        self.margins = options.margins;
        self.layoutMode = "Linear";

        self.stdInit(options);

        self.layout();
        self.updateAndRender(self.model.root);
    },

    layout : function() {
        /**
         * Creates the basic layout of a linear tree by precalculating fixed values.
         * One of calculations are also made here
         */

        var self = this;

        self.tree = new PhyloTreeLayout().layoutMode("Linear");
        self.diagonal = d3.svg.diagonal()
            .projection(function(d) { return [d.y, d.x ]; });
    },

    renderNodes : function (source) {
        /**
         * Renders the nodes base on Linear layout.
         */
        var self = this,
            fontSize = self.model.get("fontSize") + "px";

        // assigning properties from models
        self.tree.separation(self.model.get("separation")).leafHeight(self.model.get("leafHeight"));

        var duration = 500,
            nodes = self.tree.separation(self.model.get("separation")).nodes(self.model.root);

        var node = self.vis.selectAll("g.node")
            .data(nodes, function(d) { return d.name + d.id || (d.id = ++self.i); });

        // These variables has to be passed into update links which are in the base methods
        self.nodes = nodes;
        self.duration = duration;

        // ------- D3 ENTRY --------
        // Enter any new nodes at the parent's previous position.
        var nodeEnter = node.enter().append("svg:g")
            .attr("class", "node")
            .on("dblclick", function(){ d3.event.stopPropagation();    })
            .on("click", function(d) {
                if (d3.event.altKey) {
                    self.selectNode(d);        // display info if alt is pressed
                } else {
                    if(d.children && d.children.length === 0){ return;}  // there is no need to toggle leaves
                    self.model.toggle(d);   // contract/expand nodes at data level
                    self.updateAndRender(d);   // re-render the tree
                }
            });

        nodeEnter.attr("transform", function(d) { return "translate(" + source.y0 + "," + source.x0 + ")"; });

        nodeEnter.append("svg:circle")
            .attr("r", 1e-6)
            .style("fill", function(d) { return d._children ? "lightsteelblue" : "#fff"; });

        nodeEnter.append("svg:text")
            .attr("class", "nodeLabel")
            .attr("x", function(d) { return d.children || d._children ? -10 : 10; })
            .attr("dy", ".35em")
            .attr("text-anchor", function(d) { return d.children || d._children ? "end" : "start"; })
            .style("fill-opacity", 1e-6);

        // ------- D3 TRANSITION --------
        // Transition nodes to their new position.
        var nodeUpdate = node.transition()
            .duration(duration);

        nodeUpdate.attr("transform", function(d) {
            return "translate(" + d.y + "," + d.x + ")"; });

        nodeUpdate.select("circle")
            .attr("r", self.defaults.nodeRadius)
            .style("fill", function(d) { return d._children ? "lightsteelblue" : "#fff"; });

        nodeUpdate.select("text")
            .style("fill-opacity", 1)
            .style("font-size", fontSize)
            .text(function(d) { return d.name; });

        // ------- D3 EXIT --------
        // Transition exiting nodes to the parent's new position.
        var nodeExit =node.exit().transition()
            .duration(duration)
            .remove();

        nodeExit.select("circle")
            .attr("r", 1e-6);

        nodeExit.select("text")
            .style("fill-opacity", 1e-6);

        // Stash the old positions for transition.
        nodes.forEach(function(d) {
            d.x0 = d.x; // we need the x0, y0 for parents with children
            d.y0 = d.y;
        });
    }

});

var PhylovizView = Backbone.View.extend({

    className: 'phyloviz',

    initialize: function(options) {
        var self = this;
        // -- Default values of the vis
        self.MIN_SCALE = 0.05; //for zooming
        self.MAX_SCALE = 5;
        self.MAX_DISPLACEMENT = 500;
        self.margins = [10, 60, 10, 80];

        self.width = $("#PhyloViz").width();
        self.height = $("#PhyloViz").height();
        self.radius = self.width;
        self.data = options.data;

        // -- Events Phyloviz view responses to
        $(window).resize(function(){
            self.width = $("#PhyloViz").width();
            self.height = $("#PhyloViz").height();
            self.render();
        });

        // -- Create phyloTree model
        self.phyloTree = new PhyloTree(options.config);
        self.phyloTree.root = self.data;

        // -- Set up UI functions of main view
        self.zoomFunc = d3.behavior.zoom().scaleExtent([self.MIN_SCALE, self.MAX_SCALE]);
        self.zoomFunc.translate(self.phyloTree.get("translate"));
        self.zoomFunc.scale(self.phyloTree.get("scaleFactor"));

        // -- set up header buttons, search and settings menu
        self.navMenu = new HeaderButtons(self);
        self.settingsMenu = new SettingsMenu({phyloTree : self.phyloTree});
        self.nodeSelectionView = new NodeSelectionView({phyloTree : self.phyloTree});
        self.search = new PhyloVizSearch();


        setTimeout(function(){      // using settimeout to call the zoomAndPan function according to the stored attributes in viz_config
            self.zoomAndPan();
        }, 1000);
    },

    render: function(){
        // -- Creating helper function for vis. --
        var self = this;
        $("#PhyloViz").empty();

        // -- Layout viz. --
        self.mainSVG = d3.select("#PhyloViz").append("svg:svg")
            .attr("width", self.width)
            .attr("height", self.height)
            .attr("pointer-events", "all")
            .call(self.zoomFunc.on("zoom", function(){
            self.zoomAndPan();
        }));

        self.boundingRect = self.mainSVG.append("svg:rect")
            .attr("class", "boundingRect")
            .attr("width", self.width)
            .attr("height", self.height)
            .attr("stroke", "black")
            .attr("fill", "white");

        self.vis = self.mainSVG
            .append("svg:g")
            .attr("class", "vis");

        self.layoutOptions = {
            model : self.phyloTree,
            width : self.width,
            height : self.height,
            vis: self.vis,
            margins: self.margins
        };

        // -- Creating Title
        $("#title").text("Phylogenetic Tree from " + self.phyloTree.get("title") + ":");

        // -- Create Linear view instance --
        var linearView = new PhylovizLinearView(self.layoutOptions);
    },

    zoomAndPan : function(event){
        /**
         * Function to zoom and pan the svg element which the entire tree is contained within
         * Uses d3.zoom events, and extend them to allow manual updates and keeping states in model
         */
         var zoomParams,
            translateParams;
        if (typeof event !== "undefined") {
            zoomParams = event.zoom;
            translateParams = event.translate;
        }

        var self = this,
            scaleFactor = self.zoomFunc.scale(),
            translationCoor = self.zoomFunc.translate(),
            zoomStatement = "",
            translateStatement = "";

        // Do manual scaling.
        switch (zoomParams) {
            case "reset":
                scaleFactor = 1.0;
                translationCoor = [0,0]; break;
            case "+":
                scaleFactor *= 1.1; break;
            case "-":
                scaleFactor *= 0.9; break;
            default:
                if (typeof zoomParams === "number") {
                    scaleFactor = zoomParams;
                } else if (d3.event !== null) {
                    scaleFactor = d3.event.scale;
                }
        }
        if (scaleFactor < self.MIN_SCALE || scaleFactor > self.MAX_SCALE) { return;}
        self.zoomFunc.scale(scaleFactor); //update scale Factor
        zoomStatement = "translate(" +  self.margins[3] + "," + self.margins[0] + ")" +
            " scale(" + scaleFactor + ")";

        // Do manual translation.
        if( d3.event !== null) {
            translateStatement = "translate(" + d3.event.translate + ")";
        } else {
            if(typeof translateParams !== "undefined") {
                var x = translateParams.split(",")[0];
                var y = translateParams.split(",")[1];
                if (!isNaN(x) && !isNaN(y)){
                    translationCoor = [translationCoor[0] + parseFloat(x), translationCoor[1] + parseFloat(y)];
                }
            }
            self.zoomFunc.translate(translationCoor);   // update zoomFunc
            translateStatement = "translate(" + translationCoor + ")";
        }

        self.phyloTree.set("scaleFactor", scaleFactor);
        self.phyloTree.set("translate", translationCoor);
        self.vis.attr("transform", translateStatement + zoomStatement); //refers to the view that we are actually zooming
    },


    reloadViz : function() {
        /**
         * Primes the Ajax URL to load another Nexus tree
         */
        var self = this,
            treeIndex = $("#phylovizNexSelector :selected").val();
        $.getJSON(self.phyloTree.get("dataset").url(), { tree_index: treeIndex, data_type: 'raw_data' }, function(packedJson){
            self.data = packedJson.data;
            self.config = packedJson;
            self.render();
        });
    }
});


var HeaderButtons = Backbone.View.extend({

    initialize : function(phylovizView){
        var self = this;
        self.phylovizView = phylovizView;

        // Clean up code - if the class initialized more than once
        $("#panelHeaderRightBtns").empty();
        $("#phyloVizNavBtns").empty();
        $("#phylovizNexSelector").off();

        self.initNavBtns();
        self.initRightHeaderBtns();

        // Initial a tree selector in the case of nexus
        $("#phylovizNexSelector").off().on("change",  function() {self.phylovizView.reloadViz();}  );

    },

    initRightHeaderBtns : function(){
        var self = this;

        rightMenu = create_icon_buttons_menu([
            { icon_class: 'gear', title: 'PhyloViz Settings', on_click: function(){
                $("#SettingsMenu").show();
                self.settingsMenu.updateUI();
            } },
            { icon_class: 'disk', title: 'Save visualization', on_click: function() {
                var nexSelected = $("#phylovizNexSelector option:selected").text();
                if(nexSelected) {
                    self.phylovizView.phyloTree.set("title", nexSelected);
                }
                self.phylovizView.phyloTree.save();
            } },
            { icon_class: 'chevron-expand', title: 'Search / Edit Nodes', on_click: function() {
                $("#nodeSelectionView").show();
            } },
            { icon_class: 'information', title: 'Phyloviz Help', on_click: function() {
                window.open('http://wiki.g2.bx.psu.edu/Learn/Visualization/PhylogeneticTree');
                // https://docs.google.com/document/d/1AXFoJgEpxr21H3LICRs3EyMe1B1X_KFPouzIgrCz3zk/edit
            } }
        ],
            {
                tooltip_config: { placement: 'bottom' }
            });
        $("#panelHeaderRightBtns").append(rightMenu.$el);
    },

    initNavBtns: function() {
        var self = this,
            navMenu = create_icon_buttons_menu([
                { icon_class: 'zoom-in', title: 'Zoom in', on_click: function() {
                    self.phylovizView.zoomAndPan({ zoom : "+"});
                } },
                { icon_class: 'zoom-out', title: 'Zoom out', on_click: function() {
                    self.phylovizView.zoomAndPan({ zoom : "-"});
                } },
                { icon_class: 'arrow-circle', title: 'Reset Zoom/Pan', on_click: function() {
                    self.phylovizView.zoomAndPan({ zoom : "reset"});
                } }
            ],
                {
                    tooltip_config: { placement: 'bottom' }
                });
        $("#phyloVizNavBtns").append(navMenu.$el);
    }
});


var SettingsMenu = UserMenuBase.extend({

    className: 'Settings',

    initialize: function(options){
        // settings needs to directly interact with the phyloviz model so it will get access to it.
        var self = this;
        self.phyloTree = options.phyloTree;
        self.el = $("#SettingsMenu");
        self.inputs = {
            separation : $("#phyloVizTreeSeparation"),
            leafHeight : $("#phyloVizTreeLeafHeight"),
            fontSize   : $("#phyloVizTreeFontSize")
        };

        //init all buttons of settings
        $("#settingsCloseBtn").off().on("click", function() { self.el.hide(); });
        $("#phylovizResetSettingsBtn").off().on("click", function() { self.resetToDefaults(); });
        $("#phylovizApplySettingsBtn").off().on("click", function() { self.apply(); });
    },

    apply : function(){
        /**
         * Applying user values to phylotree model.
         */
        var self = this;
        if (!self.isAcceptableValue(self.inputs.separation, 50, 2500) ||
            !self.isAcceptableValue(self.inputs.leafHeight, 5, 30) ||
            !self.isAcceptableValue(self.inputs.fontSize, 5, 20)){
            return;
        }
        $.each(self.inputs, function(key, $input){
            self.phyloTree.set(key, $input.val());
        });
    },
    updateUI : function(){
        /**
         * Called to update the values input to that stored in the model
         */
        var self = this;
        $.each(self.inputs, function(key, $input){
            $input.val(self.phyloTree.get(key));
        });
    },
    resetToDefaults : function(){
        /**
         * Resets the value of the phyloTree model to its default
         */
        $(".bs-tooltip").remove();      // just in case the tool tip was not removed
        var self = this;
        $.each(self.phyloTree.defaults, function(key, value) {
            self.phyloTree.set(key, value);
        });
        self.updateUI();
    },

    render: function(){

    }

});


var NodeSelectionView = UserMenuBase.extend({
    /**
     * View for inspecting node properties and editing them
     */
    className: 'Settings',

    initialize : function (options){
        var self = this;
        self.el = $("#nodeSelectionView");
        self.phyloTree = options.phyloTree;

        self.UI = {
            enableEdit      : $('#phylovizEditNodesCheck'),
            saveChanges     : $('#phylovizNodeSaveChanges'),
            cancelChanges   : $("#phylovizNodeCancelChanges"),
            name            : $("#phyloVizSelectedNodeName"),
            dist            : $("#phyloVizSelectedNodeDist"),
            annotation      : $("#phyloVizSelectedNodeAnnotation")
        };

        self.valuesOfConcern = {
            name : null,
            dist : null,
            annotation : null
        }; // temporarily stores the values in case user change their mind

        //init UI buttons
        $("#nodeSelCloseBtn").off().on("click", function() { self.el.hide(); });
        self.UI.saveChanges.off().on("click", function(){ self.updateNodes(); });
        self.UI.cancelChanges.off().on("click", function(){ self.cancelChanges(); });

        (function ($) {
            // extending jquery fxn for enabling and disabling nodes.
            $.fn.enable = function (isEnabled) {
                return $(this).each(function () {
                    if(isEnabled){
                        $(this).removeAttr('disabled');
                    } else {
                        $(this).attr('disabled', 'disabled');
                    }
                });
            };
        })(jQuery);

        self.UI.enableEdit.off().on("click", function () {
            self.toggleUI();
        });
    },

    toggleUI : function(){
        /**
         * For turning on and off the child elements
         */
        var self = this,
            checked = self.UI.enableEdit.is(':checked');

        if (!checked) { self.cancelChanges(); }

        $.each(self.valuesOfConcern, function(key, value) {
            self.UI[key].enable(checked);
        });
        if(checked){
            self.UI.saveChanges.show();
            self.UI.cancelChanges.show();
        } else {
            self.UI.saveChanges.hide();
            self.UI.cancelChanges.hide();
        }

    },

    cancelChanges : function() {
        /**
         * Reverting to previous values in case user change their minds
         */
        var self = this,
            node = self.phyloTree.get("selectedNode");
        if (node){
            $.each(self.valuesOfConcern, function(key, value) {
                self.UI[key].val(node[key]);
            });
        }
    },

    updateNodes : function (){
        /**
         * Changing the data in the underlying tree with user-specified values
         */
        var self = this,
            node = self.phyloTree.get("selectedNode");
        if (node){
            if (!self.isAcceptableValue(self.UI.dist, 0, 1) ||
                self.hasIllegalJsonCharacters(self.UI.name) ||
                self.hasIllegalJsonCharacters(self.UI.annotation) ) {
                return;
            }
            $.each(self.valuesOfConcern, function(key, value) {
                (node[key]) = self.UI[key].val();
            });
            self.phyloTree.set("nodeAttrChangedTime", new Date());
        } else {
            alert("No node selected");
        }
    }


});



var PhyloVizSearch = UserMenuBase.extend({
    /**
     * Initializes the search panel on phyloviz and handles its user interaction
     * It allows user to search the entire free based on some qualifer, like dist <= val.
     */
    initialize : function () {
        var self = this;

        $("#phyloVizSearchBtn").on("click", function(){
            var searchTerm = $("#phyloVizSearchTerm"),
                searchConditionVal = $("#phyloVizSearchCondition").val().split("-"),
                attr = searchConditionVal[0],
                condition = searchConditionVal[1];
            self.hasIllegalJsonCharacters(searchTerm);

            if (attr === "dist"){
                self.isAcceptableValue(searchTerm, 0, 1);
            }
            self.searchTree(attr, condition, searchTerm.val());
        });
    },

    searchTree : function (attr, condition, val){
        /**
         * Searches the entire tree and will highlight the nodes that match the condition in green
         */
        d3.selectAll("g.node")
            .classed("searchHighlight", function(d){
                var attrVal =  d[attr];
                if (typeof attrVal !== "undefined" && attrVal !== null){
                    if (attr === "dist"){
                        switch (condition) {
                            case "greaterEqual":
                                return attrVal >= +val;
                            case "lesserEqual":
                                return attrVal <= +val;
                            default:
                                return;
                        }

                    } else if (attr === "name" || attr === "annotation") {
                        return attrVal.toLowerCase().indexOf(val.toLowerCase()) !== -1;
                    }
                }
            });
    }
});

return {
    PhylovizView: PhylovizView
};

});